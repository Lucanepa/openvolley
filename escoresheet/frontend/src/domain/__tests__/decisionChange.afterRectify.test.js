// The decision change on the first rally after a going back (audit LOG-03).
//
// A going back (domain/rectify) gives the serve to the team it names
// (rectification.payload.serve), and a point it sets by hand
// (payload.scoreAdjusted) won no rally and passes no serve. The decision
// change took the server of the changed rally from the team of the previous
// point row: after a going back that was the wrong team, so "Assign to other
// team" rotated the team that had served, and the take-back of a libero
// replacement after the point (row 19) judged the rotations wrong. All of
// them now ask the app's serve rule (rules serveBeforePoint, the
// servingTeamFromLog of the log before the point).
import { describe, it, expect } from 'vitest'
import { decisionChangeTakeBack } from '../interruptionRequests'
import { decisionChangeOutcomes } from '../decisionChange'
import { servingTeamFromLog, serveBeforePoint } from '../rules'

const match = { firstServe: 'home', coinTossTeamA: 'home', coinTossTeamB: 'away', bestOf: 5 }
const H0 = { I: '1', II: '2', III: '3', IV: '4', V: '5', VI: '6' }
const A0 = { I: '11', II: '12', III: '13', IV: '14', V: '15', VI: '16' }
const rot = (l) => ({ I: l.II, II: l.III, III: l.IV, IV: l.V, V: l.VI, VI: l.I })
const H1 = rot(H0)
const A1 = rot(A0)

let id = 1
const ev = (type, payload, seq) => ({ id: id++, matchId: 1, setIndex: 1, type, payload, seq, ts: new Date(1_800_000_000_000 + seq * 1000).toISOString() })

// 1:1 (away served last and rotated), a going back that sets 2:1 by hand
// (a point for home that won no rally) with away keeping the serve, then
// home wins the rally away served: a side-out, home rotates (3:1)
function afterGoBack() {
  return [
    ev('lineup', { team: 'home', lineup: H0, isInitial: true }, 1),
    ev('lineup', { team: 'away', lineup: A0, isInitial: true }, 2),
    ev('set_start', {}, 3),
    ev('rally_start', {}, 4), ev('point', { team: 'home', score: { home: 1, away: 0 } }, 5),
    ev('rally_start', {}, 6), ev('point', { team: 'away', score: { home: 1, away: 1 } }, 7),
    ev('lineup', { team: 'away', lineup: A1 }, 7.1),
    ev('rectification', { serve: 'away' }, 8),
    ev('point', { team: 'home', score: { home: 2, away: 1 }, rectification: true, scoreAdjusted: true }, 8.1),
    ev('rally_start', {}, 9), ev('point', { team: 'home', score: { home: 3, away: 1 } }, 10),
    ev('lineup', { team: 'home', lineup: H1 }, 10.1)
  ]
}
const pointAt = (events, seq) => events.find(e => e.type === 'point' && e.seq === seq)

describe('serveBeforePoint: who served the rally a point ended', () => {
  it('after a going back: the team it gave the serve to, not the team of the point set by hand', () => {
    const events = afterGoBack()
    const point = pointAt(events, 10)
    expect(serveBeforePoint(events, point, 1, match)).toBe('away')
    // the old reading (the previous point row's team) said home
    const previous = events.filter(e => e.type === 'point' && e.seq < 10).pop()
    expect(previous.payload.team).toBe('home')
  })

  it('the set\'s first server before any rally, the previous rally\'s winner otherwise; never the point\'s own rows', () => {
    const events = afterGoBack()
    expect(serveBeforePoint(events, pointAt(events, 5), 1, match)).toBe('home')
    expect(serveBeforePoint(events, pointAt(events, 7), 1, match)).toBe('home')
    // the point itself and its rotation row (10.1) are not "before" it
    expect(serveBeforePoint(events, pointAt(events, 10), 1, match)).toBe(servingTeamFromLog(events.filter(e => e.seq < 10), 1, match))
    // set 2: the other team serves first (no point of set 1 counts)
    const set2 = { ...ev('point', { team: 'home' }, 20), setIndex: 2 }
    expect(serveBeforePoint([...events, set2], set2, 2, match)).toBe('away')
  })

  it('the dialog\'s preview reads the same rule: replay gives the serve back to away', () => {
    const events = afterGoBack()
    const out = decisionChangeOutcomes({ events, point: pointAt(events, 10), score: { home: 3, away: 1 }, match })
    expect(out.replay).toEqual({ home: 2, away: 1, serve: 'away' })
    expect(out.swap).toEqual({ home: 2, away: 2, serve: 'away' })
  })
})

describe('decision change take-back after a going back (row 19)', () => {
  it('with a libero entry after the side-out: the swap and the replay take it back (its line-up was the rotated one)', () => {
    const events = [
      ...afterGoBack(),
      // home's libero (20) replaces the player in V of the ROTATED line-up (H1.V = '6')
      ev('libero_entry', { team: 'home', position: 'V', playerOut: '6', liberoIn: 20, liberoType: 'libero1' }, 11),
      ev('lineup', { team: 'home', lineup: { ...H1, V: '20' }, liberoSubstitution: { position: 'V', liberoNumber: 20, playerNumber: '6' } }, 11.1)
    ]
    const take = decisionChangeTakeBack(events, 1, match)
    expect(take).not.toBeNull()
    const entry = events.find(e => e.type === 'libero_entry')
    // FIVB 7.6.1: given to away (who served), home won no rally: its rotation goes
    expect(take.byOption.swap.requests).toContain(entry)
    expect(take.byOption.swap.reasons[entry.id]).toBe('rotation')
    expect(take.byOption.replay.requests).toContain(entry)
    expect(take.byOption.replay.reasons[entry.id]).toBe('rotation')
  })

  it('with the serving team\'s libero entry instead: it fits the swap (away does not rotate) and stays', () => {
    const events = [
      ...afterGoBack(),
      // away's libero (30) replaces the player in V of away's line-up (A1.V = '16')
      ev('libero_entry', { team: 'away', position: 'V', playerOut: '16', liberoIn: 30, liberoType: 'libero1' }, 11),
      ev('lineup', { team: 'away', lineup: { ...A1, V: '30' }, liberoSubstitution: { position: 'V', liberoNumber: 30, playerNumber: '16' } }, 11.1)
    ]
    const take = decisionChangeTakeBack(events, 1, match)
    expect(take).not.toBeNull()
    // the old reading had away receiving, so "rotated by the swap": taken back
    expect(take.byOption.swap.requests).toEqual([])
    expect(take.byOption.replay.requests).toEqual([])
  })

  it('without a libero entry after the side-out: only the time-out is taken back', () => {
    const events = [...afterGoBack(), ev('timeout', { team: 'away' }, 11)]
    const take = decisionChangeTakeBack(events, 1, match)
    expect(take.point.seq).toBe(10)
    expect(take.byOption.swap.requests.map(e => e.type)).toEqual(['timeout'])
    expect(take.byOption.replay.requests.map(e => e.type)).toEqual(['timeout'])
  })

  it('control, the same rallies without the going back: the home entry is taken back for its rotation', () => {
    const events = [
      ev('lineup', { team: 'home', lineup: H0, isInitial: true }, 1),
      ev('lineup', { team: 'away', lineup: A0, isInitial: true }, 2),
      ev('set_start', {}, 3),
      ev('rally_start', {}, 4), ev('point', { team: 'home', score: { home: 1, away: 0 } }, 5),
      ev('rally_start', {}, 6), ev('point', { team: 'away', score: { home: 1, away: 1 } }, 7),
      ev('lineup', { team: 'away', lineup: A1 }, 7.1),
      ev('rally_start', {}, 9), ev('point', { team: 'home', score: { home: 2, away: 1 } }, 10),
      ev('lineup', { team: 'home', lineup: H1 }, 10.1),
      ev('libero_entry', { team: 'home', position: 'V', playerOut: '6', liberoIn: 20, liberoType: 'libero1' }, 11),
      ev('lineup', { team: 'home', lineup: { ...H1, V: '20' }, liberoSubstitution: { position: 'V', liberoNumber: 20, playerNumber: '6' } }, 11.1)
    ]
    const take = decisionChangeTakeBack(events, 1, match)
    const entry = events.find(e => e.type === 'libero_entry')
    expect(take.byOption.swap.requests).toContain(entry)
    expect(take.byOption.swap.reasons[entry.id]).toBe('rotation')
  })
})
