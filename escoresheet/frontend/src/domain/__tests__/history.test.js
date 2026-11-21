import { describe, it, expect } from 'vitest'
import {
  historyRows, setInformation, courtLine, courtsAfterRallies, playedSets, orderRows, searchRows,
  rowTone, clockWithSeconds, inSetFilter
} from '../history'
import { buildMatch, MATCH, HOME_TEAM, AWAY_TEAM, pointsFor } from './fixtures/correctionsMatch'
import { buildSheetModel } from '../../../scoresheet_pdf/utils/sheetModel'
import { normalizeMatchData } from '../../../scoresheet_pdf/utils/matchData'

const ctxOf = (match = MATCH) => ({ match, homeTeam: HOME_TEAM, awayTeam: AWAY_TEAM })
const points = (rows) => rows.filter(r => r.kind === 'point')

describe('history: score columns', () => {
  it('Team A and Team B from the coin toss, the point counted on its own row', () => {
    // away won the toss: away is Team A
    const match = { ...MATCH, coinTossTeamA: 'away', coinTossTeamB: 'home' }
    const { events } = buildMatch({ match, sets: [{ points: 'HHA' }] })
    const pts = points(historyRows(events, ctxOf(match)))
    expect(pts.map(r => [r.scoreA, r.scoreB])).toEqual([[0, 1], [0, 2], [1, 2]])
    expect(pts[0].what).toBe('Point for VC Smash')
  })

  it('a time-out between points shows the score at that moment', () => {
    const { events } = buildMatch({ sets: [{ points: 'HAH', extras: [{ at: 2, type: 'timeout', payload: { team: 'away' } }] }] })
    const to = historyRows(events, ctxOf()).find(r => r.kind === 'timeout')
    expect([to.scoreA, to.scoreB]).toEqual([1, 1])
    expect(to.what).toBe('Time-out · Volley Bern (B)')
  })

  it('every set starts at 0:0; the set end carries the final score', () => {
    const { events } = buildMatch({ sets: [{ points: pointsFor(25, 20), finished: true }, { points: 'AH' }] })
    const rows = historyRows(events, ctxOf())
    const end = rows.find(r => r.kind === 'set_end')
    expect([end.scoreA, end.scoreB]).toEqual([25, 20])
    const set2 = points(rows).filter(r => r.setIndex === 2)
    expect(set2.map(r => [r.scoreA, r.scoreB])).toEqual([[0, 1], [1, 1]])
  })
})

describe('history: line-ups after a point', () => {
  it('both teams on every point, positions I-VI; the side-out rotates the receiving team', () => {
    // home serves first: H keeps the serve (no rotation), A is a side-out
    const { events } = buildMatch({ sets: [{ points: 'HAH' }] })
    const [p1, p2, p3] = points(historyRows(events, ctxOf()))
    expect(p1.lineupA.text).toBe('1,2,3,4,5,6')
    expect(p1.lineupB.text).toBe('11,12,13,14,15,16')
    // away wins the serve back: away rotates (12 now serves), home stays
    expect(p2.lineupA.text).toBe('1,2,3,4,5,6')
    expect(p2.lineupB.text).toBe('12,13,14,15,16,11')
    // home wins it back: home rotates
    expect(p3.lineupA.text).toBe('2,3,4,5,6,1')
    expect(p3.lineupB.text).toBe('12,13,14,15,16,11')
    expect(p3.lineupA.positions.map(x => x.pos)).toEqual(['I', 'II', 'III', 'IV', 'V', 'VI'])
  })

  it('the libero is shown where he plays, and moves with the rotation', () => {
    const { events } = buildMatch({ sets: [{ points: 'HA', extras: [{ at: 0, type: 'libero_entry', payload: { team: 'away', playerOut: 11, liberoIn: 20 } }] }] })
    const [p1, p2] = points(historyRows(events, ctxOf()))
    expect(p1.lineupB.text).toBe('L20,12,13,14,15,16')
    expect(p1.lineupB.positions[0]).toEqual({ pos: 'I', number: '20', libero: true })
    expect(p2.lineupB.text).toBe('12,13,14,15,16,L20')
    expect(p2.lineupA.positions.some(x => x.libero)).toBe(false)
  })

  it('the libero leaves when the rotation takes him to the front row', () => {
    // away serves first; home's libero replaces #1 (position I), home's
    // side-outs take him VI, V and then to IV: #1 comes back there
    const match = { ...MATCH, firstServe: 'away' }
    const { events } = buildMatch({ match, sets: [{ points: 'HAHAH', extras: [{ at: 0, type: 'libero_entry', payload: { team: 'home', playerOut: 1, liberoIn: 9 } }] }] })
    const ctx = ctxOf(match)
    const [p1, , p3, , p5] = points(historyRows(events, ctx))
    expect(p1.lineupA.text).toBe('2,3,4,5,6,L9')
    expect(p3.lineupA.text).toBe('3,4,5,6,L9,2')
    expect(p5.lineupA.text).toBe('4,5,6,1,2,3')
    expect(p5.lineupA.positions.some(x => x.libero)).toBe(false)
    // the automatic exit is hidden, and shown with the automatic entries
    expect(historyRows(events, ctx).some(r => r.kind === 'libero_exit')).toBe(false)
    const exit = historyRows(events, ctx, { showAutomatic: true }).find(r => r.kind === 'libero_exit')
    expect(exit.automatic).toBe(true)
    expect(exit.tone).toBe('auto')
    expect(exit.what).toBe('Libero #9 out at the front row, #1 in · VC Smash (A)')
    // the libero's entry is a row of its own (muted)
    const entry = historyRows(events, ctx).find(r => r.kind === 'libero_entry')
    expect(entry.what).toBe('Libero #9 in for #1 · VC Smash (A)')
    expect(entry.tone).toBe('muted')
  })

  it('a substitution changes the court of the next point', () => {
    const { events } = buildMatch({ sets: [{ points: 'HH', extras: [{ at: 1, type: 'substitution', payload: { team: 'home', playerOut: 3, playerIn: 7 } }] }] })
    const [p1, p2] = points(historyRows(events, ctxOf()))
    expect(p1.lineupA.text).toBe('1,2,3,4,5,6')
    expect(p2.lineupA.text).toBe('1,2,7,4,5,6')
  })

  it('only rallies carry line-ups', () => {
    const { events } = buildMatch({ sets: [{ points: 'HA', extras: [{ at: 1, type: 'timeout', payload: { team: 'home' } }] }] })
    const rows = historyRows(events, ctxOf())
    for (const r of rows) {
      if (r.kind === 'point') expect(r.lineupA).not.toBeNull()
      else expect([r.lineupA, r.lineupB]).toEqual([null, null])
    }
  })

  it('courtLine: null without a line-up, "?" for an empty position', () => {
    expect(courtLine(null)).toBeNull()
    expect(courtLine({ lineup: {} })).toBeNull()
    expect(courtLine({ lineup: { I: 1, II: 2, III: '', IV: 4, V: 5, VI: 6 } }).text).toBe('1,2,?,4,5,6')
    // the libero recorded by position only (old rows without his number)
    expect(courtLine({ lineup: { I: 1, II: 2, III: 3, IV: 4, V: 9, VI: 6 }, liberoSubstitution: { position: 'V' } }).text).toBe('1,2,3,4,L9,6')
  })

  it('courtsAfterRallies: one entry per rally, keyed by the event', () => {
    const { events } = buildMatch({ sets: [{ points: 'HAH' }] })
    const map = courtsAfterRallies(events)
    expect(map.size).toBe(3)
    const second = events.filter(e => e.type === 'point')[1]
    expect(map.get(second).away.text).toBe('12,13,14,15,16,11')
  })
})

describe('history: rows, tones and filters', () => {
  const rich = () => buildMatch({
    sets: [
      {
        points: pointsFor(25, 20),
        finished: true,
        extras: [
          { at: 2, type: 'sanction', payload: { team: 'away', type: 'warning', playerNumber: 8, playerType: 'player' } },
          { at: 3, type: 'court_captain_designation', payload: { team: 'home', playerNumber: 4 } }
        ]
      },
      { points: 'AH' }
    ]
  })

  it('hides the automatic rows (rally starts, rotations) unless asked', () => {
    const { events } = rich()
    const rows = historyRows(events, ctxOf())
    expect(rows.some(r => r.kind === 'rally_start')).toBe(false)
    expect(rows.some(r => r.kind === 'lineup' && r.automatic)).toBe(false)
    // set starts always show; the first one is the match start
    const starts = rows.filter(r => r.kind === 'set_start')
    expect(starts.map(r => r.what)).toEqual(['Match start · Set 1 start', 'Set 2 start'])
    const all = historyRows(events, ctxOf(), { showAutomatic: true })
    expect(all.filter(r => r.kind === 'rally_start')).toHaveLength(47)
    expect(all.find(r => r.kind === 'rally_start').what).toBe('Rally starts')
    expect(all.find(r => r.kind === 'lineup' && r.automatic).what).toMatch(/^Rotation of /)
  })

  it('tones: set rows blue, sanctions amber, captain and libero muted', () => {
    const { events } = rich()
    const rows = historyRows(events, ctxOf(), { showAutomatic: true })
    const tone = (kind) => rows.find(r => r.kind === kind).tone
    expect(tone('set_start')).toBe('set')
    expect(tone('set_end')).toBe('set')
    expect(tone('sanction')).toBe('sanction')
    expect(tone('court_captain_designation')).toBe('muted')
    expect(tone('point')).toBe('plain')
    expect(tone('rally_start')).toBe('auto')
    expect(rowTone({ type: 'libero_entry' })).toBe('muted')
    const s = rows.find(r => r.kind === 'sanction')
    expect(s.what).toBe('Warning — Player #8 · Volley Bern (B)')
  })

  it('the set filter keeps one set; order and search', () => {
    const { events } = rich()
    const rows = historyRows(events, ctxOf(), { setFilter: 2 })
    expect(new Set(rows.map(r => r.setIndex))).toEqual(new Set([2]))
    expect(points(rows)).toHaveLength(2)
    expect(orderRows(rows, 'newest')[0]).toBe(rows[rows.length - 1])
    expect(orderRows(rows, 'oldest')).toBe(rows)
    const all = historyRows(events, ctxOf())
    expect(searchRows(all, 'warning').map(r => r.kind)).toEqual(['sanction'])
    expect(searchRows(all, '25:20').map(r => r.kind)).toContain('set_end')
    expect(searchRows(all, '12,13,14').length).toBeGreaterThan(0)
    expect(searchRows(all, '  ')).toBe(all)
    expect(inSetFilter({ setIndex: 3 }, 'all')).toBe(true)
    expect(inSetFilter({ setIndex: 3 }, '2')).toBe(false)
  })

  it('times in the hall\'s clock, with seconds', () => {
    expect(clockWithSeconds('2026-10-03T18:00:15Z')).toBe('20:00:15')
    expect(clockWithSeconds(null)).toBe('')
    const { events } = rich()
    expect(historyRows(events, ctxOf())[0].time).toMatch(/^\d\d:\d\d:\d\d$/)
  })

  it('playedSets: the sets with a start, points or entries', () => {
    const { events, sets } = rich()
    expect(playedSets(events, sets, MATCH)).toEqual([{ index: 1, number: 1 }, { index: 2, number: 2 }])
    // best of 3: the deciding set (index 5) is set 3
    expect(playedSets([{ type: 'point', setIndex: 5, payload: { team: 'home' } }], [], { bestOf: 3 })).toEqual([{ index: 5, number: 3 }])
  })
})

describe('set information', () => {
  // home is A. Set 1: #7 in for #2 at 7:5, #2 back for #7 at 16:14; away #17
  // in for #13; a warning, a delay warning and a delay penalty, the coach
  // expelled, an improper request; an exceptional substitution and a
  // libero unable to play in set 2
  const sheetMatch = () => buildMatch({
    sets: [
      {
        points: pointsFor(25, 20),
        finished: true,
        extras: [
          { at: 3, type: 'timeout', payload: { team: 'away' } },
          { at: 12, type: 'substitution', payload: { team: 'home', playerOut: 2, playerIn: 7 } },
          { at: 14, type: 'substitution', payload: { team: 'away', playerOut: 13, playerIn: 17 } },
          { at: 20, type: 'sanction', payload: { team: 'away', type: 'delay_warning' } },
          { at: 22, type: 'sanction', payload: { team: 'away', type: 'warning', playerNumber: 12, playerType: 'player' } },
          { at: 25, type: 'sanction', payload: { team: 'home', type: 'improper_request' } },
          { at: 30, type: 'substitution', payload: { team: 'home', playerOut: 7, playerIn: 2 } },
          { at: 33, type: 'sanction', payload: { team: 'away', type: 'delay_penalty' } },
          { at: 40, type: 'sanction', payload: { team: 'home', type: 'expulsion', role: 'Coach', playerType: 'official' } },
          { at: 41, type: 'timeout', payload: { team: 'home' } }
        ]
      },
      {
        points: pointsFor(25, 18),
        finished: true,
        extras: [
          { at: 5, type: 'substitution', payload: { team: 'away', playerOut: 14, playerIn: 18, isExceptional: true, isExpelled: true } },
          { at: 9, type: 'libero_unable', payload: { team: 'home', liberoNumber: 9, reason: 'injury' } }
        ]
      }
    ]
  })

  it('substitutions per team: score in, and score out when the substitute went back out', () => {
    const { events } = sheetMatch()
    const info = setInformation(events, ctxOf())
    expect(info.substitutions.A).toEqual([
      expect.objectContaining({ set: 1, in: '7', out: '2', scoreIn: '7:5', scoreOut: '16:14', team: 'A' })
    ])
    // not back yet: no score out; the exceptional one is not a regular substitution
    expect(info.substitutions.B).toEqual([
      expect.objectContaining({ set: 1, in: '17', out: '13', scoreIn: '6:8', scoreOut: '' })
    ])
  })

  it('the substitution scores are the scoresheet\'s (buildSetData)', () => {
    const { events, sets, match } = sheetMatch()
    const sheet = buildSheetModel(normalizeMatchData({ match, homeTeam: HOME_TEAM, awayTeam: AWAY_TEAM, homePlayers: [], awayPlayers: [], sets, events }), { lfpShown: false })
    const pairs = (columns) => columns.filter(c => c.length).map(([first, back]) => ({ in: String(first.playerIn), out: String(first.playerOut), scoreIn: first.score, scoreOut: back ? back.score : '' }))
    const info = setInformation(events, ctxOf(), { setFilter: 1 })
    const mine = (rows) => rows.map(r => ({ in: r.in, out: r.out, scoreIn: r.scoreIn, scoreOut: r.scoreOut }))
    // set 1: Team A on the left
    expect(mine(info.substitutions.A)).toEqual(pairs(sheet.set1Data.leftSubs))
    expect(mine(info.substitutions.B)).toEqual(pairs(sheet.set1Data.rightSubs))
  })

  it('sanctions in the paper\'s columns, scores and codes as the scoresheet prints them', () => {
    const { events, sets, match } = sheetMatch()
    const info = setInformation(events, ctxOf())
    expect(info.sanctions.map(s => [s.set, s.team, s.column, s.code, s.score])).toEqual([
      [1, 'B', 'W', 'D', '9:11'],
      [1, 'B', 'W', '12', '10:12'],
      [1, 'B', 'P', 'D', '15:18'],
      [1, 'A', 'E', 'C', '22:18']
    ])
    expect(info.improperRequests).toEqual([expect.objectContaining({ set: 1, team: 'A', score: '14:11' })])
    const sheet = buildSheetModel(normalizeMatchData({ match, homeTeam: HOME_TEAM, awayTeam: AWAY_TEAM, homePlayers: [], awayPlayers: [], sets, events }), { lfpShown: false })
    const letterOf = { warning: 'W', penalty: 'P', expulsion: 'E', disqualification: 'D' }
    expect(sheet.sanctionsInBox.map(s => [s.set, s.team, letterOf[s.type], s.playerNr, s.score])).toEqual(info.sanctions.map(s => [s.set, s.team, s.column, s.code, s.score]))
    expect(sheet.improperRequests).toEqual({ teamA: true, teamB: false })
  })

  it('injuries and exceptional substitutions, and the time-outs', () => {
    const { events } = sheetMatch()
    const info = setInformation(events, ctxOf())
    expect(info.injuries.map(i => [i.set, i.team, i.number, i.kind, i.score])).toEqual([
      [2, 'B', '14', 'exceptional', '2:3'],
      [2, 'A', '9', 'liberoUnable', '5:4']
    ])
    expect(info.injuries[0].what).toBe('Exceptional substitution: #18 in for #14 · expulsion')
    expect(info.injuries[1].what).toBe('Libero #9 declared unable to play · injury')
    expect(info.timeouts.map(x => [x.set, x.team, x.score])).toEqual([[1, 'B', '1:2'], [1, 'A', '22:19']])
  })

  it('the set filter: one set only', () => {
    const { events } = sheetMatch()
    const set2 = setInformation(events, ctxOf(), { setFilter: 2 })
    expect(set2.substitutions.A).toEqual([])
    expect(set2.substitutions.B).toEqual([])
    expect(set2.sanctions).toEqual([])
    expect(set2.timeouts).toEqual([])
    expect(set2.injuries).toHaveLength(2)
    const set1 = setInformation(events, ctxOf(), { setFilter: '1' })
    expect(set1.injuries).toEqual([])
    expect(set1.sanctions).toHaveLength(4)
  })

  it('a substitute taken off by an exceptional substitution: his row gets a score out', () => {
    const { events } = buildMatch({
      sets: [{
        points: 'HHAA',
        extras: [
          { at: 1, type: 'substitution', payload: { team: 'home', playerOut: 3, playerIn: 7 } },
          { at: 3, type: 'substitution', payload: { team: 'home', playerOut: 7, playerIn: 8, isExceptional: true, isInjury: true } }
        ]
      }]
    })
    const info = setInformation(events, ctxOf())
    expect(info.substitutions.A).toEqual([expect.objectContaining({ in: '7', out: '3', scoreIn: '1:0', scoreOut: '2:1' })])
    expect(info.injuries).toEqual([expect.objectContaining({ number: '7', kind: 'exceptional', score: '2:1' })])
    expect(info.injuries[0].what).toBe('Exceptional substitution: #8 in for #7 · injury')
  })
})
