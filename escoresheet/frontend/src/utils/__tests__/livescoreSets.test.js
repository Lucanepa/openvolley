import { describe, it, expect } from 'vitest'
import {
  liveBestOf,
  liveSetNumber,
  teamAIsHome,
  liveSetsWon,
  liveSetResults,
  isStaleGame,
  listedGames,
  countLiveGames,
  applyMatchRowChange,
  liveStateNeedsFreshSnapshot,
  ENDED_LISTED_MS,
  IDLE_LISTED_MS
} from '../livescoreModel'

const NOW = Date.parse('2026-10-05T20:00:00.000Z')
const ago = (ms) => new Date(NOW - ms).toISOString()
const MIN = 60 * 1000
const HOUR = 60 * MIN

// Game 991303 of the e2e run: best of 3, Team A = home; A won set 1 25-2,
// B won set 2 25-18 and the decider 15-10 (stored as set 5).
const SET_RESULTS = [{ set: 1, home: 25, away: 2 }, { set: 2, home: 18, away: 25 }, { set: 5, home: 10, away: 15 }]

describe('liveSetNumber: the real set number of a best-of-3 decider', () => {
  it('shows set 3 for index 5 of a best-of-3, set 5 of a best-of-5', () => {
    expect(liveSetNumber({ current_set: 5, best_of: 3, sets_won_a: 1, sets_won_b: 1 })).toBe(3)
    expect(liveSetNumber({ current_set: 5, best_of: 5, sets_won_a: 2, sets_won_b: 2 })).toBe(5)
    expect(liveSetNumber({ current_set: 2, best_of: 3 })).toBe(2)
    expect(liveSetNumber({})).toBe(1)
  })

  it('infers best-of-3 for rows without best_of from the sets played', () => {
    expect(liveBestOf({ current_set: 5, sets_won_a: 1, sets_won_b: 1 })).toBe(3)
    expect(liveBestOf({ current_set: 5, sets_won_a: 2, sets_won_b: 1, match_status: 'ended' })).toBe(3)
    expect(liveBestOf({ current_set: 5, sets_won_a: 2, sets_won_b: 2 })).toBe(5)
    expect(liveBestOf({ current_set: 3 })).toBe(5)
    expect(liveBestOf({ best_of: '3' })).toBe(3)
  })

  it('a best-of-5 interval before the decider with Team B\'s set dropped (old scoreboards) stays set 5', () => {
    // 2:2 pushed as 2:1 at the set_end of set 4
    expect(liveBestOf({ current_set: 5, sets_won_a: 2, sets_won_b: 1, match_status: 'interval' })).toBe(5)
    expect(liveSetNumber({ current_set: 5, sets_won_a: 2, sets_won_b: 1, match_status: 'interval' })).toBe(5)
    // ...a finished best-of-3 2:1 is still set 3
    expect(liveSetNumber({ current_set: 5, sets_won_a: 1, sets_won_b: 2, match_status: 'ended' })).toBe(3)
    // the joined match's own format wins over any guess
    expect(liveBestOf({ current_set: 5, sets_won_a: 1, sets_won_b: 1, matches: { match_info: { best_of: 5 } } })).toBe(5)
  })
})

describe('liveSetsWon: FINAL counts the sets Team B won', () => {
  it('a finished match counts its set results, whatever the live row says', () => {
    // the live row of the e2e run: sets_won_b never counted
    const game = { match_status: 'ended', sets_won_a: 1, sets_won_b: 1, matches: { set_results: SET_RESULTS } }
    expect(liveSetsWon(game)).toEqual({ a: 1, b: 2 })
  })

  it('works when Team A is the away team (from the coin toss, the home name, or the counts)', () => {
    const swapped = SET_RESULTS.map((s) => ({ set: s.set, home: s.away, away: s.home })) // home won 2, away 1
    // Team A = away won 1 set; the old scoreboard left B (home) at 1
    const base = { match_status: 'ended', sets_won_a: 1, sets_won_b: 1, team_a_name: 'Away VC', team_b_name: 'Home VC' }
    expect(liveSetsWon({ ...base, matches: { set_results: swapped, coin_toss: { team_a: 'away' } } })).toEqual({ a: 1, b: 2 })
    expect(liveSetsWon({ ...base, matches: { set_results: swapped, home_team: { name: 'Home VC' } } })).toEqual({ a: 1, b: 2 })
    expect(liveSetsWon({ ...base, matches: { set_results: swapped } })).toEqual({ a: 1, b: 2 })
    expect(teamAIsHome({ ...base, matches: { set_results: swapped } })).toBe(false)
  })

  it('production game 382748 (set results 3-2, shown FINAL 2:2) reads 2:3', () => {
    const results = [
      { set: 1, home: 25, away: 20 }, { set: 2, home: 20, away: 25 }, { set: 3, home: 25, away: 22 },
      { set: 4, home: 23, away: 25 }, { set: 5, home: 15, away: 12 }
    ]
    // home won 3: Team A has 2, so A is away and B (home) won 3
    expect(liveSetsWon({ match_status: 'ended', sets_won_a: 2, sets_won_b: 2, matches: { set_results: results } })).toEqual({ a: 2, b: 3 })
  })

  it('in play, or without set results, the live row counts as is', () => {
    expect(liveSetsWon({ match_status: 'interval', sets_won_a: 1, sets_won_b: 1, matches: { set_results: SET_RESULTS.slice(0, 2) } })).toEqual({ a: 1, b: 1 })
    expect(liveSetsWon({ match_status: 'ended', sets_won_a: 2, sets_won_b: 0 })).toEqual({ a: 2, b: 0 })
    // incomplete set results never lower the counts
    expect(liveSetsWon({ match_status: 'ended', sets_won_a: 2, sets_won_b: 1, matches: { set_results: SET_RESULTS.slice(0, 1) } })).toEqual({ a: 2, b: 1 })
  })
})

describe('liveSetResults', () => {
  it('maps home/away to Team A/B and shows the decider as set 3', () => {
    const game = { match_status: 'ended', best_of: 3, sets_won_a: 1, sets_won_b: 2, matches: { set_results: SET_RESULTS, coin_toss: { team_a: 'home' } } }
    expect(liveSetResults(game)).toEqual([{ set: 1, a: 25, b: 2 }, { set: 2, a: 18, b: 25 }, { set: 3, a: 10, b: 15 }])
    const awayA = { ...game, matches: { ...game.matches, coin_toss: { team_a: 'away' } } }
    expect(liveSetResults(awayA)[0]).toEqual({ set: 1, a: 2, b: 25 })
  })
})

describe('stale rows', () => {
  const ended = (updated) => ({ match_id: 'e', match_status: 'ended', sets_won_a: 2, updated_at: updated })
  const playing = (updated) => ({ match_id: 'p', match_status: 'in_progress', points_a: 3, updated_at: updated })

  it('drops finished matches and abandoned ones after a while', () => {
    expect(isStaleGame(ended(ago(10 * MIN)), NOW)).toBe(false)
    expect(isStaleGame(ended(ago(ENDED_LISTED_MS + MIN)), NOW)).toBe(true)
    expect(isStaleGame(playing(ago(IDLE_LISTED_MS - MIN)), NOW)).toBe(false)
    expect(isStaleGame(playing(ago(IDLE_LISTED_MS + MIN)), NOW)).toBe(true)
    // game 382231: stuck at 'Set 4' (interval) since January
    expect(isStaleGame({ match_status: 'interval', updated_at: '2026-01-29T19:00:00Z' }, NOW)).toBe(true)
    expect(isStaleGame({ match_status: 'in_progress' }, NOW)).toBe(false)
  })

  it('listedGames hides stale rows, even ones already shown', () => {
    const shown = new Set(['p'])
    expect(listedGames([playing(ago(5 * HOUR)), ended(ago(MIN))], shown, NOW).map((g) => g.match_id)).toEqual(['e'])
  })

  it('a match being played on a scorer whose clock is hours slow stays listed once this page sees it change', () => {
    const seen = new Map()
    const slow = (points) => ({ match_id: 's', match_status: 'in_progress', points_a: points, updated_at: ago(4 * HOUR + points * MIN) })
    // First sighting: only the scorer's (slow) timestamp is known
    expect(listedGames([slow(1)], new Set(), NOW, seen)).toEqual([])
    // The next rally arrives: this page saw it change now
    expect(listedGames([slow(2)], new Set(), NOW + MIN, seen).map((g) => g.match_id)).toEqual(['s'])
    // ...and it goes stale after IDLE_LISTED_MS of silence by this page's clock
    expect(listedGames([slow(2)], new Set(), NOW + MIN + IDLE_LISTED_MS + MIN, seen)).toEqual([])
    // A row seen once is not "news": an old abandoned row stays hidden
    const old = new Map()
    expect(listedGames([playing(ago(5 * HOUR))], new Set(['p']), NOW, old)).toEqual([])
    expect(listedGames([playing(ago(5 * HOUR))], new Set(['p']), NOW + MIN, old)).toEqual([])
    expect(isStaleGame(playing(ago(5 * HOUR)), NOW, NOW - MIN)).toBe(false)
  })

  it('counts only the games still being played as live', () => {
    expect(countLiveGames([ended(ago(MIN)), playing(ago(MIN)), { match_status: 'final' }, { match_status: 'interval' }])).toBe(2)
    expect(countLiveGames([])).toBe(0)
  })
})

describe('applyMatchRowChange: who Team A is', () => {
  it('keeps the coin toss team and home team name of a (public) matches change', () => {
    const games = [{ match_id: 'm1', matches: { set_results: [] } }]
    const next = applyMatchRowChange(games, { eventType: 'UPDATE', new: { id: 'm1', coin_toss: { team_a: 'away', confirmed: true }, home_team: { name: 'Home VC', color: '#f00' } } })
    expect(next[0].matches).toEqual({ set_results: [], coin_toss: { team_a: 'away' }, home_team: { name: 'Home VC' } })
    // nothing new: same array
    expect(applyMatchRowChange(next, { eventType: 'UPDATE', new: { id: 'm1', coin_toss: { team_a: 'away' } } })).toBe(next)
    expect(applyMatchRowChange(next, { eventType: 'UPDATE', new: { id: 'm1', status: 'live' } })).toBe(next)
  })
})

describe('liveStateNeedsFreshSnapshot', () => {
  it('the deciding-set court switch and manual changes push a fresh snapshot', () => {
    expect(liveStateNeedsFreshSnapshot('court_switch')).toBe(true)
    expect(liveStateNeedsFreshSnapshot('manual_side_change')).toBe(true)
    // set 5 coin toss sides / first serve are match fields, not events
    expect(liveStateNeedsFreshSnapshot('manual_set5_setup')).toBe(true)
    expect(liveStateNeedsFreshSnapshot('end_interval')).toBe(true)
    expect(liveStateNeedsFreshSnapshot('point')).toBe(false)
    expect(liveStateNeedsFreshSnapshot(null)).toBe(false)
  })
})
