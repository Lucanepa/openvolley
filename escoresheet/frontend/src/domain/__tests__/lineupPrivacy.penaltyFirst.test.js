// A set that opens with a penalty point before the first serve (payload
// penaltySeq; domain/rally isFirstRallyOf: the set has NOT started) keeps its
// first line-up covered on every path, not only on the screens (audit round 3
// LOG-19). Home's line-up of set 2 is in, away's not yet: the away bench must
// not get it, from the scorer's live push, the cloud relay's bundle or live
// state, or the referee tablet's live scoresheet input.
import { describe, it, expect } from 'vitest'
import { relayBundleView, relayLiveStateView, coveredLiveLineupTeam } from '../../../../backend/lib/publicColumns.js'
import { coveredLineupTeamsOf, lineupHiddenUntilBoth, startsSet } from '../lineupPrivacy'
import { isFirstRallyOf } from '../rally'
import { withoutLoneLineups } from '../../components/referee/scoresheetInput'

const lineup = { I: 7, II: 4, III: 11, IV: 9, V: 3, VI: 12 }
const events = [
  { id: 1, seq: 1, setIndex: 1, type: 'set_end', payload: { team: 'home' } },
  { id: 2, seq: 2, setIndex: 2, type: 'point', payload: { team: 'away', penaltySeq: 1 } },
  { id: 3, seq: 3, setIndex: 2, type: 'lineup', payload: { team: 'home', lineup, isInitial: true } }
]
const entry = {
  match: { coinTossTeamA: 'home' }, homePlayers: [], awayPlayers: [], sets: [], events,
  liveState: { current_set: 2, points_a: 0, points_b: 1, lineup_a: lineup, lineup_b: null }
}

describe('a penalty point before the first serve does not start the set (LOG-19)', () => {
  it('one rule: startsSet agrees with the scorer\'s isFirstRallyOf', () => {
    const cases = [
      events,
      [...events, { id: 4, seq: 4, setIndex: 2, type: 'rally_start', payload: {} }],
      [...events, { id: 4, seq: 4, setIndex: 2, type: 'point', payload: { team: 'home' } }],
      [...events, { id: 4, seq: 4, setIndex: 2, type: 'set_start', payload: {} }]
    ]
    for (const list of cases) expect(!list.filter((e) => e.setIndex === 2).some(startsSet)).toBe(isFirstRallyOf(list, 2))
    expect(isFirstRallyOf(events, 2)).toBe(true)
    expect(lineupHiddenUntilBoth({ setStarted: false, ownEntered: true, otherEntered: false })).toBe(true)
  })

  it('the scorer\'s live push covers home\'s line-up', () => {
    expect(coveredLineupTeamsOf(events, 2)).toEqual(['home'])
  })

  it('the cloud relay gives the away bench neither the line-up event nor lineup_a', () => {
    const away = relayBundleView(entry, 'away')
    expect(away.events.some((e) => e.type === 'lineup' && e.payload.team === 'home')).toBe(false)
    expect(away.liveState.lineup_a).toBe(null)
    expect(relayLiveStateView(entry.liveState, 'away', entry.match, entry.events).lineup_a).toBe(null)
    expect(coveredLiveLineupTeam(entry.liveState, entry.match, entry.events)).toBe('home')
    // the home bench and the referee still get it
    expect(relayLiveStateView(entry.liveState, 'home', entry.match, entry.events).lineup_a).toEqual(lineup)
    expect(relayLiveStateView(entry.liveState, 'referee', entry.match, entry.events).lineup_a).toEqual(lineup)
  })

  it('the referee tablet\'s live scoresheet leaves the lone line-up out', () => {
    expect(withoutLoneLineups(events).some((e) => e.type === 'lineup')).toBe(false)
  })

  it('once the first rally starts, the line-up is no longer covered', () => {
    const started = [...events, { id: 4, seq: 4, setIndex: 2, type: 'rally_start', payload: {} }]
    expect(coveredLineupTeamsOf(started, 2)).toEqual([])
    expect(relayBundleView({ ...entry, events: started }, 'away').events.some((e) => e.type === 'lineup')).toBe(true)
    expect(relayLiveStateView(entry.liveState, 'away', entry.match, started).lineup_a).toEqual(lineup)
    expect(withoutLoneLineups(started).some((e) => e.type === 'lineup')).toBe(true)
  })
})
