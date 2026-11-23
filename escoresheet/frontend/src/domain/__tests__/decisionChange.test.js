// The decision change dialog's preview: the score and who serves after each
// option (domain/decisionChange). The replay option named the point's team
// as the next server: wrong after a side-out, where the team that served the
// rally (the other one) serves it again (plan of 22.11.2026).
import { describe, it, expect } from 'vitest'
import { decisionChangeOutcomes } from '../decisionChange'

const ev = (type, seq, payload = {}, setIndex = 1) => ({ type, seq, setIndex, payload })
const point = (seq, team) => ev('point', seq, { team })
const match = { firstServe: 'home' }

describe('decisionChangeOutcomes', () => {
  it('after a side-out (away won home\'s serve): replay gives the serve back to home', () => {
    // home served and scored (1:0), then away won the rally on home's serve (1:1)
    const last = point(5, 'away')
    const events = [ev('set_start', 1), ev('rally_start', 2), point(3, 'home'), ev('rally_start', 4), last, ev('lineup', 5.1, { team: 'away' })]
    const out = decisionChangeOutcomes({ events, point: last, score: { home: 1, away: 1 }, match })
    expect(out.replay).toEqual({ home: 1, away: 0, serve: 'home' })
    expect(out.swap).toEqual({ home: 2, away: 0, serve: 'home' })
    expect(out.record_replay).toEqual({ home: 1, away: 1, serve: 'away' })
  })

  it('without a side-out (the server scored): replay keeps the serve with that team', () => {
    const last = point(5, 'home')
    const events = [ev('set_start', 1), point(3, 'home'), last]
    const out = decisionChangeOutcomes({ events, point: last, score: { home: 2, away: 0 }, match })
    expect(out.replay).toEqual({ home: 1, away: 0, serve: 'home' })
    expect(out.swap).toEqual({ home: 1, away: 1, serve: 'away' })
    expect(out.record_replay).toEqual({ home: 2, away: 0, serve: 'home' })
  })

  it('the first point of a set: the set\'s first server serves the replayed rally', () => {
    // set 2: away serves first (set 1 home)
    const last = { ...point(10, 'home'), setIndex: 2 }
    const out = decisionChangeOutcomes({ events: [{ ...ev('set_start', 9), setIndex: 2 }, last], point: last, score: { home: 1, away: 0 }, match })
    expect(out.replay).toEqual({ home: 0, away: 0, serve: 'away' })
  })

  it('never a negative score', () => {
    const last = point(3, 'away')
    expect(decisionChangeOutcomes({ events: [last], point: last, score: { home: 0, away: 0 }, match }).swap.away).toBe(0)
  })
})
