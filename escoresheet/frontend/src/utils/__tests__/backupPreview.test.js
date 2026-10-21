import { describe, it, expect } from 'vitest'
import { summarizeBackup } from '../backupPreview'

// A cloud backup's shape (backup_g406970_set3_scoreleft25_scoreright20_…):
// substitution payloads carry team / position / playerOut / playerIn and no
// score; point payloads carry `team` (and a `score` the preview never needs).
let seq = 0
const ev = (setIndex, type, payload, extra = {}) => ({ setIndex, type, payload, seq: ++seq, ts: `2026-10-20T18:${String(seq).padStart(2, '0')}:00Z`, ...extra })
const points = (setIndex, teams) => teams.split('').map(c => ev(setIndex, 'point', { team: c === 'h' ? 'home' : 'away' }))

function backup() {
  seq = 0
  return {
    match: { status: 'ended', scheduledAt: '2026-10-20T18:00:00+00:00' },
    homeTeam: { name: 'VBC Rämi D1' },
    awayTeam: { name: 'VBC Einsiedeln D2' },
    sets: [
      { index: 3, homePoints: 25, awayPoints: 20, finished: true },
      { index: 1, homePoints: 25, awayPoints: 10, finished: true },
      { index: 2, homePoints: 25, awayPoints: 12, finished: true }
    ],
    events: [
      ev(1, 'lineup', { team: 'home', lineup: { I: 2, II: 13, III: 4, IV: 7, V: 10, VI: 17 } }),
      ev(1, 'lineup', { team: 'away', lineup: { I: 7, II: 5, III: 9, IV: 6, V: 8, VI: 4 } }),
      ...points(1, 'hhh'),
      ev(1, 'substitution', { team: 'away', position: 'I', playerOut: '8', playerIn: 10 }),
      ev(3, 'lineup', { team: 'home', lineup: { I: 13, II: 7, III: 8, IV: 18, V: 2, VI: 4 } }),
      ev(3, 'lineup', { team: 'away', lineup: { I: 9, II: 6, III: 10, IV: 4, V: 7, VI: 5 } }),
      ...points(3, 'hahaa'), // 2:3
      ev(3, 'timeout', { team: 'home' }),
      ev(3, 'substitution', { team: 'home', position: 'I', playerOut: '13', playerIn: 6 }),
      ev(3, 'lineup', { team: 'home', lineup: { I: 6, II: 7, III: 8, IV: 18, V: 2, VI: 4 }, fromSubstitution: true }),
      ...points(3, 'hh'), // 4:3
      ev(3, 'substitution', { team: 'home', position: 'IV', playerOut: '18', playerIn: 17 }),
      ev(3, 'lineup', { team: 'home', lineup: { I: 6, II: 7, III: 8, IV: 17, V: 2, VI: 4 }, fromSubstitution: true }),
      ...points(3, 'aa'), // 4:5
      ev(3, 'timeout', { team: 'away' }),
      ev(3, 'timeout', { team: 'away' }),
      ...points(3, 'h') // 5:5, home serves
    ]
  }
}

describe('summarizeBackup (Restore preview)', () => {
  it('best of 3: the deciding set (index 5) reads set 3, from the match or its match_info', () => {
    const sets = [{ index: 1, homePoints: 25, awayPoints: 20, finished: true }, { index: 5, homePoints: 4, awayPoints: 2 }]
    const app = summarizeBackup({ match: { bestOf: 3 }, sets, events: [] })
    expect([app.setIndex, app.setNumber]).toEqual([5, 3])
    expect(app.sets.map(x => x.number)).toEqual([1, 3])
    const db = summarizeBackup({ match: { home_team: 'H', match_info: { best_of: 3 } }, sets, events: [] })
    expect(db.setNumber).toBe(3)
    expect(summarizeBackup({ match: {}, sets, events: [] }).setNumber).toBe(5)
  })

  it('shows each substitution at the score it happened, not 0-0', () => {
    const s = summarizeBackup(backup())
    expect(s.setIndex).toBe(3)
    expect(s.substitutions.home.map(x => [x.playerIn, x.playerOut, x.home, x.away])).toEqual([
      [6, '13', 2, 3],
      [17, '18', 4, 3]
    ])
    // the set-1 substitution is not one of set 3's
    expect(s.substitutions.away).toEqual([])
  })

  it('counts points in log order even when the events come unsorted', () => {
    const b = backup()
    b.events.reverse()
    const s = summarizeBackup(b)
    expect(s.substitutions.home.map(x => `${x.home}:${x.away}`)).toEqual(['2:3', '4:3'])
  })

  it("shows the current set's latest line-up, not the first line-up of the match", () => {
    const s = summarizeBackup(backup())
    expect(s.lineup.home).toEqual({ I: 6, II: 7, III: 8, IV: 17, V: 2, VI: 4 })
    expect(s.lineup.away).toEqual({ I: 9, II: 6, III: 10, IV: 4, V: 7, VI: 5 })
  })

  it('reads the latest set, the time-outs of that set and the set scores in order', () => {
    const s = summarizeBackup(backup())
    expect(s.score).toEqual({ home: 25, away: 20 })
    expect(s.timeouts).toEqual({ home: 1, away: 2 })
    expect(s.sets.map(x => `${x.index} ${x.home}:${x.away}`)).toEqual(['1 25:10', '2 25:12', '3 25:20'])
    expect(s.teams).toEqual({ home: 'VBC Rämi D1', away: 'VBC Einsiedeln D2' })
  })

  it('serving: the winner of the last rally (point payload `team`)', () => {
    const b = backup()
    expect(summarizeBackup(b).serving).toBe('home')
    b.events.push(...points(3, 'a'))
    expect(summarizeBackup(b).serving).toBe('away')
  })

  it('serving at the start of a set: the last state snapshot, else unknown', () => {
    const b = backup()
    b.sets.push({ index: 4, homePoints: 0, awayPoints: 0, finished: false })
    b.events.push(ev(4, 'set_start', {}, { stateSnapshot: { servingTeam: 'away' } }))
    expect(summarizeBackup(b).serving).toBe('away')
    b.events = b.events.filter(e => e.type !== 'set_start')
    expect(summarizeBackup(b).serving).toBe(null)
  })

  it('a database restore (match.home_team, liveState, home_points)', () => {
    const s = summarizeBackup({
      match: { home_team: { name: 'A' }, away_team: 'B' },
      liveState: { current_set: 2, points_a: 3, points_b: 4, lineup_a: { I: 1 }, lineup_b: null, serving_team: 'away' },
      sets: [{ index: 1, home_points: 25, away_points: 23, finished: true }]
    })
    expect(s.teams).toEqual({ home: 'A', away: 'B' })
    expect(s.sets).toEqual([{ index: 1, number: 1, home: 25, away: 23, finished: true }])
    expect(s.lineup).toEqual({ home: { I: 1 }, away: null })
    expect(s.serving).toBe('away')
  })

  it('a database restore past set 1: its server events (set_index, state_snapshot) count in their own set', () => {
    const row = (set_index, s, type, payload, extra = {}) => ({ set_index, seq: s, type, payload, ...extra })
    const s = summarizeBackup({
      match: { home_team: 'A', away_team: 'B', status: 'live' },
      liveState: { current_set: 2, points_a: 3, points_b: 2 },
      sets: [
        { index: 1, home_points: 25, away_points: 20, finished: true },
        { index: 2, home_points: 3, away_points: 2, finished: false }
      ],
      events: [
        row(1, 1, 'lineup', { team: 'home', lineup: { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6 } }),
        row(1, 2, 'point', { team: 'away' }),
        row(1, 3, 'timeout', { team: 'home' }),
        row(2, 50, 'set_start', {}, { state_snapshot: { servingTeam: 'away' } }),
        row(2, 51, 'point', { team: 'home' }),
        row(2, 52, 'point', { team: 'home' }),
        row(2, 53, 'timeout', { team: 'away' }),
        row(2, 54, 'substitution', { team: 'away', playerIn: 9, playerOut: '8' }),
        row(2, 55, 'point', { team: 'away' })
      ]
    })
    expect(s.setIndex).toBe(2)
    expect(s.timeouts).toEqual({ home: 0, away: 1 })
    expect(s.substitutions.away.map(x => [x.playerIn, x.playerOut, x.home, x.away])).toEqual([[9, '8', 2, 0]])
    expect(s.serving).toBe('away')
    // no set-2 point yet: the set's state snapshot says who serves
    const start = summarizeBackup({
      match: { home_team: 'A', away_team: 'B' },
      liveState: { current_set: 2 },
      sets: [{ index: 2, home_points: 0, away_points: 0 }],
      events: [row(1, 1, 'point', { team: 'home' }), row(2, 2, 'set_start', {}, { state_snapshot: { servingTeam: 'away' } })]
    })
    expect(start.serving).toBe('away')
  })

  it('an empty backup gives an empty preview, not a crash', () => {
    const s = summarizeBackup({})
    expect(s.teams).toEqual({ home: null, away: null })
    expect(s.score).toEqual({ home: 0, away: 0 })
    expect(s.substitutions).toEqual({ home: [], away: [] })
    expect(s.serving).toBe(null)
  })
})
