// The decision change dialog's preview: the score and who serves after each
// option (domain/decisionChange). The replay option named the point's team
// as the next server: wrong after a side-out, where the team that served the
// rally (the other one) serves it again (plan of 22.11.2026).
// And the decision change on a replay (owner 23.11.2026: "keep decision
// change, a replay can change to another decision"): which replay it is
// offered for, what its options leave, and what Undo of the point that took
// the replay's place keeps.
import { describe, it, expect } from 'vitest'
import {
  decisionChangeOutcomes, replayToDecide, replayDecisionOutcomes, REPLAY_POINT_OPTIONS, teamOfReplayOption,
  replacedReplayRecord, rallyStartGoesWithPoint
} from '../decisionChange'

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

describe('replayToDecide: the replay a decision change can give to a team', () => {
  it('the set\'s last event is a replay: the in-play replay, the decision change\'s, continuous play\'s', () => {
    for (const payload of [{}, { reason: 'point_replay', undonePointTeam: 'home' }, { reason: 'continuous' }]) {
      const replay = ev('replay', 6, payload)
      expect(replayToDecide([ev('set_start', 1), point(3, 'home'), ev('rally_start', 5), replay], 1)).toBe(replay)
    }
  })

  it('past a remark or a bench injury recorded since', () => {
    const replay = ev('replay', 6)
    expect(replayToDecide([point(3, 'home'), ev('rally_start', 5), replay, ev('remark', 7, { text: 'x' }), ev('bench_injury', 8, { team: 'home' })], 1)).toBe(replay)
  })

  it('none once anything else came after it (a point, a sanction, a rally started), nor in another set', () => {
    expect(replayToDecide([ev('rally_start', 5), ev('replay', 6), point(7, 'home')], 1)).toBeNull()
    expect(replayToDecide([ev('rally_start', 5), ev('replay', 6), ev('sanction', 7, { team: 'home', type: 'delay_warning' })], 1)).toBeNull()
    expect(replayToDecide([ev('replay', 6), ev('rally_start', 7)], 1)).toBeNull()
    expect(replayToDecide([point(3, 'home')], 1)).toBeNull()
    expect(replayToDecide([ev('replay', 6, {}, 1), ev('set_start', 20, {}, 2)], 2)).toBeNull()
    expect(replayToDecide([], 1)).toBeNull()
    expect(replayToDecide(null, null)).toBeNull()
  })

  it('by seq, not by the order of the array', () => {
    const replay = ev('replay', 6)
    expect(replayToDecide([replay, point(3, 'home'), ev('rally_start', 5)], 1)).toBe(replay)
  })
})

describe('replayDecisionOutcomes: the replay\'s options', () => {
  it('the team given the rally scores and serves; "Rally replayed" changes nothing', () => {
    // 3:2, away served (it won the last point); the rally was replayed
    const events = [point(3, 'home'), point(4, 'away'), ev('rally_start', 5), ev('replay', 6)]
    const out = replayDecisionOutcomes({ events, setIndex: 1, score: { home: 3, away: 2 }, match })
    expect(out.point_home).toEqual({ home: 4, away: 2, serve: 'home' })
    expect(out.point_away).toEqual({ home: 3, away: 3, serve: 'away' })
    expect(out.record_replay).toEqual({ home: 3, away: 2, serve: 'away' })
  })

  it('the options name the team they give the point to', () => {
    expect(teamOfReplayOption(REPLAY_POINT_OPTIONS.home)).toBe('home')
    expect(teamOfReplayOption(REPLAY_POINT_OPTIONS.away)).toBe('away')
    expect(teamOfReplayOption('record_replay')).toBeNull()
    expect(teamOfReplayOption('swap')).toBeNull()
  })
})

describe('Undo of the point that took a replay\'s place', () => {
  it('the point keeps the replay row without its state copies', () => {
    const replay = { id: 9, matchId: 1, ...ev('replay', 6, { reason: 'point_replay' }), ts: 't', stateBefore: { big: 1 }, stateSnapshot: { big: 2 } }
    expect(replacedReplayRecord(replay)).toEqual({ id: 9, matchId: 1, type: 'replay', seq: 6, setIndex: 1, payload: { reason: 'point_replay' }, ts: 't' })
    expect(replacedReplayRecord(point(3, 'home'))).toBeNull()
    expect(replacedReplayRecord(null)).toBeNull()
  })

  it('the replayed rally\'s start stays with the replay; one the point wrote itself (continuous play) goes', () => {
    const replay = replacedReplayRecord(ev('replay', 6))
    expect(rallyStartGoesWithPoint({ ...point(8, 'home'), _replacedReplay: replay }, ev('rally_start', 5))).toBe(false)
    expect(rallyStartGoesWithPoint({ ...point(8, 'home'), _replacedReplay: replay }, ev('rally_start', 7))).toBe(true)
    // any other point: its rally's start goes, as before
    expect(rallyStartGoesWithPoint(point(8, 'home'), ev('rally_start', 5))).toBe(true)
    expect(rallyStartGoesWithPoint(point(8, 'home'), null)).toBe(false)
  })
})
