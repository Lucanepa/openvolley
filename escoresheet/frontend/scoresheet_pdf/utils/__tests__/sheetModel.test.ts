import { describe, it, expect } from 'vitest'
import { buildSheetModel } from '../sheetModel'
import { normalizeMatchData } from '../matchData'
import { deepEqual } from '../propsEqual'

// The sheet model is a pure function of the match (review 2026-11-16, F2):
// the same data gives an equal model, and the drawn page re-renders only when
// the data changes.

const at = (s: number) => new Date(Date.UTC(2026, 10, 16, 18, 0, s)).toISOString()

function match3(deciding: [number, number]) {
  let seq = 0
  const events: any[] = []
  const sets: any[] = []
  const play = (index: number, home: number, away: number) => {
    events.push({ type: 'lineup', setIndex: index, seq: ++seq, ts: at(seq), payload: { team: 'home', lineup: { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6 }, isInitial: true } })
    events.push({ type: 'lineup', setIndex: index, seq: ++seq, ts: at(seq), payload: { team: 'away', lineup: { I: 11, II: 12, III: 13, IV: 14, V: 15, VI: 16 }, isInitial: true } })
    for (let i = 0; i < home; i++) events.push({ type: 'point', setIndex: index, seq: ++seq, ts: at(seq), payload: { team: 'home' } })
    for (let i = 0; i < away; i++) events.push({ type: 'point', setIndex: index, seq: ++seq, ts: at(seq), payload: { team: 'away' } })
    sets.push({ index, homePoints: home, awayPoints: away, finished: true, startTime: at(seq - home - away), endTime: at(seq) })
  }
  play(1, 25, 20)
  play(2, 22, 25)
  play(5, deciding[0], deciding[1])
  return normalizeMatchData({
    match: { id: 'm', status: 'ended', bestOf: 3, coinTossTeamA: 'home', coinTossTeamB: 'away', coinTossServeA: true, coinTossServeB: false, set5LeftTeam: 'A', set5FirstServe: 'A', homeShortName: 'HOME', awayShortName: 'AWAY' },
    homeTeam: { name: 'Home Team' },
    awayTeam: { name: 'Away Team' },
    homePlayers: [{ number: 7, firstName: 'A', lastName: 'Seven' }, { number: 3, firstName: 'B', lastName: 'Three', libero: 'libero1' }],
    awayPlayers: [{ number: 12, firstName: 'C', lastName: 'Twelve' }],
    sets,
    events
  })
}

describe('buildSheetModel', () => {
  it('best of 3 won 2:1 in the deciding set: result, winner, sets 3 and 4 empty', () => {
    const m = buildSheetModel(match3([15, 11]), { lfpShown: false })
    expect(m.result).toBe('2-1')
    expect(m.winner).toBe('Home Team')
    expect(m.emptyGrid[3]).toBe(true)
    expect(m.emptyGrid[4]).toBe(true)
    expect(m.emptyGrid[5]).toBe(false)
    expect(m.set5Shown).toBe(true)
    expect(m.set5FinalScoreLeft).toBe(15)
    expect(m.set5FinalScoreRight).toBe(11)
    expect(m.setResults.map(r => [r.teamAPoints, r.teamBPoints])).toEqual([[25, 20], [22, 25], [null, null], [null, null], [15, 11]])
  })

  it('the deciding set splits the left team\'s points at the change of courts', () => {
    const m = buildSheetModel(match3([15, 11]), { lfpShown: false })
    // home scored its 15 points first: it reached 8 first, so the change is at 8:0
    expect(m.markedPointsA_Left).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(m.markedPointsA_Right).toEqual([9, 10, 11, 12, 13, 14, 15])
    expect(m.markedPointsB).toHaveLength(11)
  })

  it('the rosters by shirt number, LFP marks only when shown, liberos from the roster', () => {
    const data = match3([15, 11])
    ;(data.homePlayers[0] as any).isLfp = true
    expect(buildSheetModel(data, { lfpShown: false }).homeRows.map(p => [p.number, p.isLfp])).toEqual([['3', false], ['7', false]])
    expect(buildSheetModel(data, { lfpShown: true }).homeRows.map(p => [p.number, p.isLfp])).toEqual([['3', false], ['7', true]])
    expect(buildSheetModel(data, { lfpShown: false }).homeLiberos.map(p => p.number)).toEqual(['3'])
  })

  it('extra remarks follow the sheet\'s own', () => {
    const m = buildSheetModel(match3([15, 11]), { lfpShown: false, extraRemarks: ['Rebuilt after the match: 16.11.2026 - test', ' '] })
    expect(m.autoRemarks[m.autoRemarks.length - 1]).toBe('Rebuilt after the match: 16.11.2026 - test')
    expect(m.autoRemarks).not.toContain(' ')
  })

  it('the same data twice gives an equal model; one more point changes only the deciding set', () => {
    const a = buildSheetModel(match3([15, 11]), { lfpShown: false })
    const b = buildSheetModel(match3([15, 11]), { lfpShown: false })
    expect(deepEqual(a, b)).toBe(true)
    const c = buildSheetModel(match3([15, 12]), { lfpShown: false })
    expect(deepEqual(a.set1Data, c.set1Data)).toBe(true)
    expect(deepEqual(a.homeRows, c.homeRows)).toBe(true)
    expect(deepEqual(a.set5Data, c.set5Data)).toBe(false)
  })
})

describe('deepEqual (the memoised sections\' props comparison)', () => {
  it('plain values, arrays and objects by value; functions by reference', () => {
    const f = () => {}
    expect(deepEqual({ a: [1, { b: 'x' }], f }, { a: [1, { b: 'x' }], f })).toBe(true)
    expect(deepEqual({ a: [1, 2] }, { a: [1, 3] })).toBe(false)
    expect(deepEqual({ f: () => {} }, { f: () => {} })).toBe(false)
    expect(deepEqual([1], { 0: 1 })).toBe(false)
    expect(deepEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false)
  })

  it('React elements by type, key and props, never their owner', () => {
    const el = (props: any) => ({ $$typeof: Symbol.for('react.transitional.element'), type: 'span', key: null, props, _owner: { huge: true } })
    expect(deepEqual(el({ children: 'A' }), { ...el({ children: 'A' }), _owner: { other: true } })).toBe(true)
    expect(deepEqual(el({ children: 'A' }), el({ children: 'B' }))).toBe(false)
  })
})
