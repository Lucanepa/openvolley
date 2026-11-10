import { describe, it, expect } from 'vitest'
import { courtChangeIndex, roundSlot, serverColumn, splitSet5Rounds, trackServiceRounds, type TeamKey } from '../serviceRounds'

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

describe('trackServiceRounds: points cancelled by a rectification (FIVB 7.7.2, 15.9.2.3)', () => {
  it('a cancelled rally passes the serve but scores nothing', () => {
    // h serves 1, a side-out (cancelled), a (cancelled), h side-out, h
    const counted = [true, false, false, true, true]
    const r = trackServiceRounds({ pointTeams: seq('haahh'), counted, firstServer: 'home', finished: false })
    // away served one round (its two points cancelled: closed at 0); home's rounds carry its own points only
    expect(boxes(r.home)).toEqual(['I/1:/1', 'II/1:/'])
    expect(boxes(r.away)).toEqual(['II/1:/0'])
  })

  it('a point set by hand scores but passes no serve; the serve the going back gives passes it, with no rotation', () => {
    // h serves 1, a by hand (no serve), then the going back gives a the serve, h side-out.
    // a never rotated: its player at I serves, in column I (I/1 is its crossed box)
    const r = trackServiceRounds({
      pointTeams: seq('haah'), counted: [true, true, false, true], passes: [true, false, true, true],
      served: [undefined, undefined, null, undefined], firstServer: 'home', finished: false
    })
    expect(boxes(r.home)).toEqual(['I/1:/1', 'II/1:/'])
    expect(boxes(r.away)).toEqual(['I/2:/1'])
    // its next round (gained in a rally) is the rotation after it: II/1
    const next = trackServiceRounds({
      pointTeams: seq('haaha'), counted: [true, true, false, true, true], passes: [true, false, true, true, true],
      served: [undefined, undefined, null, undefined, undefined], firstServer: 'home', finished: false
    })
    expect(boxes(next.away)).toEqual(['I/2:/1', 'II/1:/'])
  })

  it('the change of courts counts valid points only', () => {
    expect(courtChangeIndex(seq('hhhhhhhhh'), 8, [false, true, true, true, true, true, true, true, true])).toBe(8)
  })
})

// 3.0.16 test match: at 5:3, B serving, Go back to 5:2, illegal substitution
// by A, point to B, "Serves next" switched to A by hand. The court kept A's
// #8 at position I serving (owner: a serve changed by hand rotates nobody);
// the sheet ended A's column II and opened III, as if A had rotated.
describe('trackServiceRounds: the serve a going back gives rotates nobody', () => {
  // A (home) serves first: I/1 2, B side-out 2, A side-out (II/1) to 5:2,
  // B side-out 5:3 (III/1), B's penalty point 5:4, then A given the serve
  const goBack = seq('hhaahhhaa')
  const given = [...goBack, 'home' as TeamKey]
  const counted = [...goBack.map(() => true), false]
  const served = [...goBack.map(() => undefined), 1]

  it('the server is the player at position I: column II again, in its next box', () => {
    const r = trackServiceRounds({ pointTeams: given, counted, served, firstServer: 'home', finished: false })
    expect(boxes(r.home)).toEqual(['I/1:/2', 'II/1:/5', 'II/2:/'])
    expect(boxes(r.away)).toEqual(['II/1:/2', 'III/1:/4'])
  })

  it('column not known: the column of the team\'s last round (no rotation)', () => {
    const r = trackServiceRounds({ pointTeams: given, counted, served: [...goBack.map(() => undefined), null], firstServer: 'home', finished: false })
    expect(boxes(r.home)).toEqual(['I/1:/2', 'II/1:/5', 'II/2:/'])
  })

  it('later rounds follow on from it: the next rotation is column III', () => {
    // A scores (6:4), B side-out (IV/1), A side-out: III/1
    const r = trackServiceRounds({
      pointTeams: [...given, ...seq('hah')], counted: [...counted, true, true, true], served: [...served, undefined, undefined, undefined],
      firstServer: 'home', finished: false
    })
    expect(boxes(r.home)).toEqual(['I/1:/2', 'II/1:/5', 'II/2:/6', 'III/1:/'])
    expect(boxes(r.away)).toEqual(['II/1:/2', 'III/1:/4', 'IV/1:/5'])
  })

  it('a line-up rotated by hand: the column of the player put at position I', () => {
    const r = trackServiceRounds({ pointTeams: given, counted, served: [...goBack.map(() => undefined), 2], firstServer: 'home', finished: false })
    expect(boxes(r.home)).toEqual(['I/1:/2', 'II/1:/5', 'III/1:/'])
  })

  it('the serve given to the team already serving opens nothing', () => {
    const r = trackServiceRounds({ pointTeams: [...goBack, 'away'], counted, served: [...goBack.map(() => undefined), null], firstServer: 'home', finished: false })
    expect(boxes(r.away)).toEqual(['II/1:/2', 'III/1:/'])
  })
})

describe('serverColumn', () => {
  const start = ['8', '3', '5', '10', '11', '1']
  it('the starting position of the player at position I', () => {
    expect(serverColumn(start, { I: 8, II: 3, III: 5, IV: 10, V: 11, VI: 1 })).toBe(0)
    expect(serverColumn(start, { I: 3, II: 5, III: 10, IV: 11, V: 1, VI: 8 })).toBe(1)
  })
  it('a substitute: the starter he replaced (also after a second substitution)', () => {
    expect(serverColumn(start, { I: 14 }, [{ playerOut: 5, playerIn: 14 }])).toBe(2)
    expect(serverColumn(start, { I: 17 }, [{ playerOut: 5, playerIn: 14 }, { playerOut: 14, playerIn: 17 }])).toBe(2)
  })
  it('the libero: the player he replaced', () => {
    expect(serverColumn(start, { I: 99 }, [], { liberoNumber: 99, playerNumber: 1 })).toBe(5)
  })
  it('null when it cannot be told', () => {
    expect(serverColumn(start, { I: 42 })).toBeNull()
    expect(serverColumn(start, null)).toBeNull()
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
