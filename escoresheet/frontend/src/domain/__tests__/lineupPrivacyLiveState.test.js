import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { coveredLineupTeamsOf, withCoveredLiveLineups } from '../lineupPrivacy'

// Audit 2026-11 (delta-bench-relays-2): the first line-up of a set was hidden
// on every screen, but the scorer's live state carried it to the relay room
// (every member, no PIN), the livescore and the database row.
const lu = (team, setIndex, seq, isInitial = true) => ({ type: 'lineup', setIndex, seq, payload: { team, isInitial, lineup: { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6 } } })
const point = (setIndex, seq) => ({ type: 'point', setIndex, seq, payload: { team: 'home' } })
const LINEUP = { I: { number: 7, isServing: true }, II: { number: 8 } }

describe('the covered line-up stays out of the live state', () => {
  it('coveredLineupTeamsOf reads the scorer\'s rule from the events of the set', () => {
    const set1 = [lu('home', 1, 1), lu('away', 1, 2), point(1, 3)]
    expect(coveredLineupTeamsOf([...set1, lu('home', 2, 4)], 2)).toEqual(['home'])
    expect(coveredLineupTeamsOf([...set1, lu('away', 2, 4)], 2)).toEqual(['away'])
    expect(coveredLineupTeamsOf([...set1, lu('home', 2, 4), lu('away', 2, 5)], 2)).toEqual([])
    // started (an easy match plays without the other line-up): shown
    expect(coveredLineupTeamsOf([lu('home', 1, 1), point(1, 2)], 1)).toEqual([])
    // only the initial line-up counts as entered, as on the scorer's court
    expect(coveredLineupTeamsOf([lu('home', 1, 1, false)], 1)).toEqual([])
    expect(coveredLineupTeamsOf([lu('home', 1, 1)], 1)).toEqual(['home'])
    expect(coveredLineupTeamsOf(null, 1)).toEqual([])
  })

  it('withCoveredLiveLineups sends the covered team\'s line-up as null, by Team A / B', () => {
    const row = { lineup_a: LINEUP, lineup_b: LINEUP, points_a: 0, last_event_type: 'court_captain_designation', last_event_team: 'away', last_event_data: { playerNumber: 8 } }
    // Team A is away: the away line-up is lineup_a
    const out = withCoveredLiveLineups(row, ['away'], 'away')
    expect(out.lineup_a).toBeNull()
    expect(out.lineup_b).toBe(LINEUP)
    expect(out.last_event_data).toBeNull()
    expect(out.last_event_type).toBe('court_captain_designation')
    expect(row.lineup_a).toBe(LINEUP)
    const home = withCoveredLiveLineups(row, ['home'], 'away')
    expect(home.lineup_b).toBeNull()
    expect(home.lineup_a).toBe(LINEUP)
    expect(home.last_event_data).toEqual({ playerNumber: 8 })
    expect(withCoveredLiveLineups(row, [], 'home')).toBe(row)
  })

  it('a rewritten log names the covered team\'s last action without its numbers', () => {
    const row = { lineup_a: LINEUP, last_event_type: 'undo', last_event_team: null, last_event_data: { lastAction: { type: 'court_captain_designation', team: 'home', data: { playerNumber: 7 }, ts: 't' } } }
    expect(withCoveredLiveLineups(row, ['home'], 'home').last_event_data).toEqual({ lastAction: { type: 'court_captain_designation', team: 'home', data: {}, ts: 't' } })
  })

  // Scoreboard cannot be mounted in a unit test: the push is pinned
  it('the scorer\'s live-state push applies it before the relay, the livescore and the database get the row', () => {
    const src = readFileSync(resolve(__dirname, '../../components/Scoreboard.jsx'), 'utf8')
    const start = src.indexOf('const syncLiveStateToSupabase = useCallback(')
    const body = src.slice(start, src.indexOf('\n  }, [', start))
    expect(body).toMatch(/const liveStateData = withCoveredLiveLineups\(\{/)
    expect(body).toMatch(/coveredLineupTeamsOf\(/)
    expect(body.indexOf('withCoveredLiveLineups(')).toBeLessThan(body.indexOf("type: 'live-state-update'"))
    expect(body.indexOf('withCoveredLiveLineups(')).toBeLessThan(body.indexOf('toCloud: async () => {'))
  })
})
