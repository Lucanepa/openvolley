import { describe, it, expect } from 'vitest'
import { courtChangeIndex, roundSlot, splitSet5Rounds, trackServiceRounds, type TeamKey } from '../serviceRounds'

// Point sequences written as a string: h = home scores, a = away scores
const seq = (s: string): TeamKey[] => [...s].map(c => (c === 'h' ? 'home' : 'away'))
const boxes = (rounds: { position: number; box: number; ticked: boolean; points: number | null; circled: boolean }[]) =>
  rounds.map(r => `${['I', 'II', 'III', 'IV', 'V', 'VI'][r.position]}/${r.box}:${r.ticked ? '/' : ''}${r.points ?? ''}${r.circled ? '()' : ''}`)

describe('roundSlot (field-spec 4.6)', () => {
  it('the receiving team starts at II/1 and reaches I/2 after six rounds', () => {
    expect(roundSlot(0, false)).toEqual({ position: 0, box: 1 })
    expect(roundSlot(5, false)).toEqual({ position: 5, box: 1 })
    expect(roundSlot(6, false)).toEqual({ position: 0, box: 2 })
    expect(roundSlot(0, true)).toEqual({ position: 1, box: 1 })
    expect(roundSlot(4, true)).toEqual({ position: 5, box: 1 })
    expect(roundSlot(5, true)).toEqual({ position: 0, box: 2 })
    expect(roundSlot(11, true)).toEqual({ position: 0, box: 3 })
  })
})

describe('trackServiceRounds (sets 1-4)', () => {
  it('no rally yet: no round (the tick comes with the first rally)', () => {
    expect(trackServiceRounds({ pointTeams: [], firstServer: 'home', finished: false })).toEqual({ home: [], away: [] })
  })

  it('side-outs close the server with its TEAM score and open the receiver', () => {
    const r = trackServiceRounds({ pointTeams: seq('hhaah'), firstServer: 'home', finished: false })
    expect(boxes(r.home)).toEqual(['I/1:/2', 'II/1:/'])
    expect(boxes(r.away)).toEqual(['II/1:/2'])
  })

  it('set end, winner serving: final in its current round, both finals circled', () => {
    // 3:1 "set" for the sake of the marks: h serves, a side-out, h side-out, h scores
    const r = trackServiceRounds({ pointTeams: seq('ahhh'), firstServer: 'home', finished: true })
    expect(boxes(r.home)).toEqual(['I/1:/0', 'II/1:/3()'])
    expect(boxes(r.away)).toEqual(['II/1:/1()'])
  })

  it('set end, winner on receive: final in the round it gained, NOT ticked (SC p.64)', () => {
    // away serves; home side-out, home, away side-out, home side-out = the last rally won on receive
    const r = trackServiceRounds({ pointTeams: seq('hhah'), firstServer: 'away', finished: true })
    expect(boxes(r.home)).toEqual(['II/1:/2', 'III/1:3()'])
    expect(boxes(r.away)).toEqual(['I/1:/0', 'II/1:/1()'])
  })
})

describe('set 5: change of courts (field-spec 6)', () => {
  it('the change is the point after which a team first has 8', () => {
    expect(courtChangeIndex(seq('hhhhhhhh'))).toBe(7)
    expect(courtChangeIndex(seq('aaaahhhhhhhh'))).toBe(11)
    expect(courtChangeIndex(seq('hhhaaa'))).toBeNull()
  })

  it('no change yet (a live set or a set stopped before 8): everything stays in panel 1', () => {
    const r = trackServiceRounds({ pointTeams: seq('hhaah'), firstServer: 'home', finished: false })
    const split = splitSet5Rounds(r.home, null)
    expect(boxes(split.before)).toEqual(['I/1:/2', 'II/1:/'])
    expect(split.after).toEqual([])
  })

  it('Situation 1, left team serving at the change: the open round carried to panel 3', () => {
    // home (left) serves from I and wins 8 in a row: the change while serving
    const points = seq('hhhhhhhh' + 'a' + 'h')
    const r = trackServiceRounds({ pointTeams: points, firstServer: 'home', finished: false })
    const split = splitSet5Rounds(r.home, courtChangeIndex(points))
    expect(boxes(split.before)).toEqual(['I/1:/']) // panel 1 as at the change: open, no score
    expect(boxes(split.after)).toEqual(['I/1:/8', 'II/1:/']) // closed later, in panel 3
  })

  it('Situation 2, left team receiving at the change: the last closed round copied with its score', () => {
    // home (left) served I, lost at 5; away reaches 8 on its serve
    const points = seq('hhhhh' + 'aaaaaaaa')
    const r = trackServiceRounds({ pointTeams: points, firstServer: 'home', finished: false })
    const split = splitSet5Rounds(r.home, courtChangeIndex(points))
    expect(boxes(split.before)).toEqual(['I/1:/5'])
    expect(boxes(split.after)).toEqual(['I/1:/5'])
  })

  it('a side-out to 8 by the left team opens its new round in panel 3 only', () => {
    // away serves first; home serves to 7:0, loses it at 7:1, side-outs to 8:1 (the change)
    const points = seq('hhhhhhh' + 'a' + 'h')
    const r = trackServiceRounds({ pointTeams: points, firstServer: 'away', finished: false })
    const at = courtChangeIndex(points)
    const split = splitSet5Rounds(r.home, at)
    expect(boxes(split.before)).toEqual(['II/1:/7'])
    expect(boxes(split.after)).toEqual(['III/1:/'])
  })

  it('the left team never served before the change: its first round after it is II/1 (or I/2 one pass later)', () => {
    // right (away) leads 8:0 on its serve, then the left team side-outs
    const points = seq('aaaaaaaa' + 'h')
    const r = trackServiceRounds({ pointTeams: points, firstServer: 'away', finished: false })
    const split = splitSet5Rounds(r.home, courtChangeIndex(points))
    expect(split.before).toEqual([])
    expect(boxes(split.after)).toEqual(['II/1:/'])
  })

  it('the loser\'s final is circled in the panel in use (panel 3 after the change), never invented in panel 1', () => {
    // 15:7 for the right team; the change at 5:8 on a side-out against the left team's serve
    const points = seq('hhhhh' + 'aaaaaaaa' + 'hh' + 'aaaaaaa')
    const r = trackServiceRounds({ pointTeams: points, firstServer: 'home', finished: true })
    const split = splitSet5Rounds(r.home, courtChangeIndex(points))
    expect(boxes(split.before)).toEqual(['I/1:/5'])
    expect(boxes(split.after)).toEqual(['I/1:/5', 'II/1:/7()'])
    expect(boxes(r.away)).toEqual(['II/1:/8', 'III/1:/15()'])
  })
})

// The audit's set-5 fixtures (2026-10, lines L1-L3): B (away) on the left, A serves first
describe('set 5 audit fixtures M1 / M2 (regression)', () => {
  const seq = (s: string) => s.split('').map(c => (c === 'h' ? 'home' : 'away')) as ('home' | 'away')[]
  const run = (s: string) => {
    const pts = seq(s)
    const tracked = trackServiceRounds({ pointTeams: pts, firstServer: 'home', finished: true })
    const split = splitSet5Rounds(tracked.away, courtChangeIndex(pts))
    return { tracked, ...split }
  }

  it('M1: B wins 15:13 on receive; its final is not ticked; the box closed at the change is copied to panel 3', () => {
    const { before, after, tracked } = run('hhaahhaahhaaha' + 'h' + 'aahaahaahahha')
    const finalB = after[after.length - 1]
    expect(finalB).toMatchObject({ points: 15, circled: true, ticked: false })
    const lastClosedP1 = [...before].reverse().find(r => r.points !== null)!
    expect(after[0]).toMatchObject({ position: lastClosedP1.position, box: lastClosedP1.box, points: lastClosedP1.points })
    // A (panel 2): its last round circled with 13
    expect(tracked.home[tracked.home.length - 1]).toMatchObject({ points: 13, circled: true })
  })

  it('M2: A wins 15:8; B\'s last closed box (8, panel 3) is circled, nothing invented in panel 1', () => {
    const { before, after } = run('hhaahhaahhaah' + 'h' + 'aa' + 'hhhhhhh')
    expect(before.some(r => r.circled)).toBe(false)
    expect(before.some(r => r.points === 8)).toBe(false)
    const last = after[after.length - 1]
    expect(last).toMatchObject({ points: 8, circled: true })
  })
})
