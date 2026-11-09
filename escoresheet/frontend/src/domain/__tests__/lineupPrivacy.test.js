import { describe, it, expect } from 'vitest'
import { lineupHiddenUntilBoth, coveredLineupTeams, withoutCoveredTeamEvents } from '../lineupPrivacy'
import { withoutLoneLineups, scoresheetInputFromBundle } from '../../components/referee/scoresheetInput'

describe('the first line-up stays hidden until the other is in', () => {
  it('only while the set has not started and only one is recorded', () => {
    expect(lineupHiddenUntilBoth({ setStarted: false, ownEntered: true, otherEntered: false })).toBe(true)
    expect(lineupHiddenUntilBoth({ setStarted: false, ownEntered: true, otherEntered: true })).toBe(false)
    expect(lineupHiddenUntilBoth({ setStarted: false, ownEntered: false, otherEntered: true })).toBe(false)
    expect(lineupHiddenUntilBoth({ setStarted: true, ownEntered: true, otherEntered: false })).toBe(false)
  })

  it('the referee\'s live scoresheet leaves a lone line-up out', () => {
    const lu = (team, setIndex, seq) => ({ type: 'lineup', setIndex, seq, payload: { team, lineup: { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6 } } })
    const set1 = [lu('home', 1, 1), lu('away', 1, 2), { type: 'point', setIndex: 1, seq: 3, payload: { team: 'home' } }]
    // set 2: only home's so far
    expect(withoutLoneLineups([...set1, lu('home', 2, 4)])).toEqual(set1)
    expect(withoutLoneLineups([...set1, lu('home', 2, 4), lu('away', 2, 5)])).toHaveLength(5)
    const input = scoresheetInputFromBundle({ access: 'full', match: { id: 1 }, sets: [{ index: 1 }], events: [lu('away', 1, 1)] })
    expect(input.events).toEqual([])
  })
})

describe('the covered team on the scorer\'s screen', () => {
  it('which team is covered', () => {
    expect(coveredLineupTeams({ setStarted: false, homeEntered: true, awayEntered: false })).toEqual(['home'])
    expect(coveredLineupTeams({ setStarted: false, homeEntered: false, awayEntered: true })).toEqual(['away'])
    expect(coveredLineupTeams({ setStarted: false, homeEntered: true, awayEntered: true })).toEqual([])
    expect(coveredLineupTeams({ setStarted: true, homeEntered: true, awayEntered: false })).toEqual([])
  })
  it('its events of the set leave the recent actions / Last action', () => {
    const ev = [
      { type: 'coin_toss', setIndex: 1, payload: {} },
      { type: 'lineup', setIndex: 1, payload: { team: 'home' } },
      { type: 'court_captain_designation', setIndex: 1, payload: { team: 'home' } },
      { type: 'lineup', setIndex: 0, payload: { team: 'home' } }
    ]
    expect(withoutCoveredTeamEvents(ev, ['home'], 1).map((e) => e.type)).toEqual(['coin_toss', 'lineup'])
    expect(withoutCoveredTeamEvents(ev, [], 1)).toBe(ev)
  })
})
