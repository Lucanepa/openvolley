// Corrections and Go back keep their links by identity, not by seq: Undo and
// Remove of a going back take back every row it wrote (line-ups edited by
// hand for either team, its penalty point, points set by hand) also after a
// correction renumbered the log; a penalty stays linked to its point; a
// decision change is undone under the point's seq now; the request rules see
// the rallies a going back cancelled or took out; a manual substitution is
// checked as the live one is.
import { describe, it, expect } from 'vitest'
import { buildMatch, MATCH, HOME_TEAM, AWAY_TEAM, pointsFor } from './fixtures/correctionsMatch'
import { rectifyMoments, planRectification, planRectificationReversal, lineupNow } from '../rectify'
import { applyPlanToEvents, planAddTimeout, planRemoveEntry, planRemoveSanction } from '../manualCorrections'
import { matchIssues } from '../recompute'
import { scoreFromPointEvents, servingTeamFromLog } from '../rules'
import { compareBySeq } from '../describe'
import { penaltyOfPoint } from '../sanctions'
import { decisionChangeUndoRecord, planDecisionChangeReversal } from '../corrections'
import { isReplayPending, requestBlockReason, isSecondSubstitutionRequest, entryWithoutCompletedRally } from '../interruptionRequests'
import { validateManualSubstitution } from '../substitutions'

const LIVE = { ...MATCH, status: 'live' }
const ctx = { match: LIVE, homeTeam: HOME_TEAM, awayTeam: AWAY_TEAM, matchId: 1, liveSetIndex: 2, now: new Date('2026-10-03T20:00:00Z') }
const score = (ev, s = 2) => { const r = scoreFromPointEvents(ev, s); return `${r.homePoints}:${r.awayPoints}` }
let nextId = 50000
const withIds = (list) => list.map(e => (e.id == null || typeof e.id === 'string' ? { ...e, id: nextId++ } : e))
const str = (l) => Object.fromEntries(Object.entries(l || {}).map(([k, v]) => [k, String(v)]))
const liveMatch = (points, extras = []) => buildMatch({ match: LIVE, sets: [{ points: pointsFor(25, 20), finished: true }, { points, finished: false, extras }] }).events
const at = (events, h, a) => rectifyMoments(events, { setIndex: 2 }, ctx).find(m => m.score.home === h && m.score.away === a)
const goBack = (events, opts) => {
  const p = planRectification(events, { setIndex: 2, ...opts }, ctx)
  expect(p.error).toBeUndefined()
  return withIds(applyPlanToEvents(events, p))
}
const reverse = (events) => {
  const head = events.find(e => e.type === 'rectification')
  const back = planRectificationReversal(events, head.id, ctx)
  expect(back.error).toBeUndefined()
  return applyPlanToEvents(events, back)
}
const integerSeqsTwice = (events) => {
  const n = {}
  for (const e of events) if (Number.isInteger(e.seq)) n[e.seq] = (n[e.seq] || 0) + 1
  return Object.keys(n).filter(k => n[k] > 1)
}

describe('Undo of a going back with line-ups edited by hand (any team)', () => {
  for (const cancel of ['home', 'both']) {
    it(`cancel ${cancel}: no line-up row of it stays, the line-ups are those of before`, () => {
      const events = liveMatch('HAHHA')
      const before = lineupNow(events, 2, 'away').lineup
      const moment = at(events, 1, 1)
      const penaltyTo = cancel === 'home' ? 'away' : null
      const first = planRectification(events, { setIndex: 2, moment, cancel, penaltyTo }, ctx)
      const away = first.preview.lineupState.away.lineup
      const after = goBack(events, { moment, cancel, penaltyTo, edits: { lineups: { away: { ...away, I: away.II, II: away.I } } } })
      const restored = reverse(after)
      expect(score(restored)).toBe(score(events))
      expect(restored.filter(e => e.payload?.fromRectification)).toHaveLength(0)
      expect(str(lineupNow(restored, 2, 'away').lineup)).toEqual(str(before))
    })
  }

  it('Remove in the corrections takes the line-up rows of both teams back too', () => {
    const events = liveMatch('HAHHA')
    const moment = at(events, 1, 1)
    const first = planRectification(events, { setIndex: 2, moment, cancel: 'both' }, ctx)
    const { home, away } = first.preview.lineupState
    const after = goBack(events, { moment, cancel: 'both', edits: { lineups: { home: { ...home.lineup, I: home.lineup.II, II: home.lineup.I }, away: { ...away.lineup, I: away.lineup.II, II: away.lineup.I } } } })
    const head = after.find(e => e.type === 'rectification')
    const restored = applyPlanToEvents(after, planRemoveEntry(after, head.id, ctx))
    expect(restored.filter(e => e.payload?.fromRectification)).toHaveLength(0)
    expect(str(lineupNow(restored, 2, 'home').lineup)).toEqual(str(lineupNow(events, 2, 'home').lineup))
    expect(str(lineupNow(restored, 2, 'away').lineup)).toEqual(str(lineupNow(events, 2, 'away').lineup))
  })
})

describe('Undo / Remove of a going back after a correction renumbered the log', () => {
  it('its penalty point goes back out after a time-out added before it', () => {
    const events = liveMatch('HAHHH')
    const after = goBack(events, { moment: at(events, 1, 1), cancel: 'home', penaltyTo: 'away' })
    expect(score(after)).toBe('1:2')
    const add = planAddTimeout(after, { setIndex: 2, team: 'away', at: 0 }, ctx)
    expect(add.error).toBeUndefined()
    const restored = reverse(withIds(applyPlanToEvents(after, add)))
    expect(score(restored)).toBe('4:1')
    expect(restored.filter(e => e.type === 'point' && e.payload?.rectification)).toHaveLength(0)
    expect(servingTeamFromLog(restored, 2, LIVE)).toBe(servingTeamFromLog(events, 2, LIVE))
  })

  it('points set by hand go back out after a time-out added in an earlier set (Remove)', () => {
    const events = liveMatch('HAHHH')
    const after = goBack(events, { moment: at(events, 1, 1), cancel: 'home', penaltyTo: null, edits: { score: { home: 1, away: 4 } } })
    expect(score(after)).toBe('1:4')
    const ren = withIds(applyPlanToEvents(after, planAddTimeout(after, { setIndex: 1, team: 'home', at: 5 }, ctx)))
    const head = ren.find(e => e.type === 'rectification')
    const restored = applyPlanToEvents(ren, planRemoveEntry(ren, head.id, ctx))
    expect(score(restored)).toBe('4:1')
    expect(restored.filter(e => e.type === 'point' && e.payload?.rectification)).toHaveLength(0)
  })

  it("'both': the rallies come back in their place, no seq used twice", () => {
    const events = liveMatch('HAHHH')
    const after = goBack(events, { moment: at(events, 1, 1), cancel: 'both' })
    expect(score(after)).toBe('1:1')
    const ren = withIds(applyPlanToEvents(after, planAddTimeout(after, { setIndex: 2, team: 'home', at: 1 }, ctx)))
    const restored = reverse(ren)
    expect(score(restored)).toBe('4:1')
    expect(integerSeqsTwice(restored)).toEqual([])
    // the time-out added at 1:0, then the four rallies taken out, each point after its rally start
    const s2 = restored.filter(e => e.setIndex === 2).sort(compareBySeq).filter(e => Number.isInteger(e.seq)).map(e => e.type)
    expect(s2.join(' ')).toMatch(/rally_start point timeout( rally_start point){4}$/)
    expect(servingTeamFromLog(restored, 2, LIVE)).toBe(servingTeamFromLog(events, 2, LIVE))
  })
})

describe("going back 'both' with a line-up edited by hand after a later substitution", () => {
  it('writes the line-up the scorer chose', () => {
    const events = liveMatch('HAHHA', [{ at: 4, type: 'substitution', payload: { team: 'home', playerOut: 4, playerIn: 7 } }])
    const moment = at(events, 1, 1)
    const first = planRectification(events, { setIndex: 2, moment, cancel: 'both' }, ctx)
    const shown = first.preview.lineupState.home.lineup
    const wanted = { ...shown, I: shown.II, II: shown.I }
    const after = goBack(events, { moment, cancel: 'both', edits: { lineups: { home: wanted } } })
    expect(str(lineupNow(after, 2, 'home').lineup)).toEqual(str(wanted))
    // and a rebuild afterwards keeps it
    const again = applyPlanToEvents(after, planAddTimeout(after, { setIndex: 2, team: 'away', at: 0 }, ctx))
    expect(str(lineupNow(again, 2, 'home').lineup)).toEqual(str(wanted))
  })
})

describe('the request rules after a going back', () => {
  it('a replay in the rallies taken out is no longer pending', () => {
    const events = liveMatch('HHAAHA', [{ at: 4, type: 'rally_start', payload: {} }, { at: 4, type: 'replay', payload: {} }])
    const after = goBack(events, { moment: at(events, 2, 2), cancel: 'both' })
    expect(isReplayPending(after, 2)).toBe(false)
    expect(requestBlockReason(after, 2, 'home', 'timeout')).not.toBe('replay_pending')
  })

  it('a substitution before the going back is no request of this interruption', () => {
    const events = liveMatch('HHAAHA', [
      { at: 4, type: 'substitution', payload: { team: 'home', playerOut: 4, playerIn: 7 } },
      { at: 4, type: 'timeout', payload: { team: 'away' } }
    ])
    const after = goBack(events, { moment: at(events, 2, 2), cancel: 'both' })
    expect(isSecondSubstitutionRequest(after, 2, 'home')).toBe(false)
    expect(entryWithoutCompletedRally(after, 2, 'home', 7)).toBeNull()
  })
})

describe('a penalty point and the going back of one team', () => {
  it('the penalty point stays, as with both teams', () => {
    // 1:1, then home rally, a penalty of away (point to home, linked), home rally
    const events = liveMatch('HAHHH', [{ at: 3, type: 'sanction', payload: { team: 'away', type: 'penalty', playerType: 'player', playerNumber: 12 } }])
    const sanction = events.find(e => e.type === 'sanction')
    const penaltyPoint = events.filter(e => e.type === 'point' && e.setIndex === 2).sort(compareBySeq).find(e => e.seq > sanction.seq)
    penaltyPoint.payload.penaltySeq = sanction.seq
    expect(penaltyOfPoint(events, penaltyPoint)?.id).toBe(sanction.id)
    const after = goBack(events, { moment: at(events, 1, 1), cancel: 'home', penaltyTo: 'away' })
    expect(after.find(e => e.id === penaltyPoint.id).type).toBe('point')
    expect(score(after)).toBe('2:2')
  })
})

describe('the penalty link after a correction', () => {
  const setup = () => {
    const { events } = buildMatch({ match: LIVE, sets: [{ points: 'HAHAHA', extras: [{ at: 5, type: 'sanction', payload: { team: 'home', type: 'penalty', playerType: 'player', playerNumber: 5 } }] }] })
    const sanction = events.find(e => e.type === 'sanction')
    const point = events.filter(e => e.type === 'point').sort(compareBySeq).pop()
    point.payload.penaltySeq = sanction.seq
    return { events, sanction, point }
  }
  const ctx1 = { ...ctx, liveSetIndex: 1, mode: 'live' }

  it('follows the sanction when a time-out added earlier renumbers the log', () => {
    const { events, sanction, point } = setup()
    const add = planAddTimeout(events, { setIndex: 1, team: 'home', at: 2 }, ctx1)
    const after = withIds(applyPlanToEvents(events, add))
    const point2 = after.find(e => e.id === point.id)
    expect(point2.seq).toBe(point.seq + 1)
    expect(penaltyOfPoint(after, point2)?.id).toBe(sanction.id)
  })

  it('is dropped when the sanction is removed', () => {
    const { events, sanction, point } = setup()
    const r = planRemoveSanction(events, sanction.id, {}, ctx1)
    expect(r.error).toBeUndefined()
    const after = applyPlanToEvents(events, r)
    expect(after.find(e => e.id === point.id).payload.penaltySeq).toBeUndefined()
  })
})

describe('Undo of a decision change after a correction renumbered the log', () => {
  it('puts the old rotation back under the point', () => {
    const { events } = buildMatch({ match: LIVE, sets: [{ points: 'HAHAHA' }] })
    const point = events.filter(e => e.type === 'point').sort(compareBySeq).pop()
    const oldRotation = events.filter(e => Math.floor(e.seq) === point.seq && e.seq !== point.seq)
    expect(oldRotation).toHaveLength(1)
    let log = events.filter(e => !oldRotation.includes(e))
    log = log.map(e => (e.id === point.id ? { ...e, payload: { ...e.payload, team: 'home' } } : e))
    const dcSeq = Math.floor(Math.max(...log.map(e => e.seq))) + 1
    log.push({ id: 900, matchId: 1, setIndex: 1, type: 'decision_change', seq: dcSeq, ts: new Date().toISOString(), payload: { fromTeam: 'away', toTeam: 'home', ...decisionChangeUndoRecord(point, oldRotation.map(e => ({ ...e })), []) } })
    const after = withIds(applyPlanToEvents(log, planAddTimeout(log, { setIndex: 1, team: 'home', at: 2 }, { ...ctx, liveSetIndex: 1, mode: 'live' })))
    const point2 = after.find(e => e.id === point.id)
    expect(point2.seq).toBe(point.seq + 1)
    const rev = planDecisionChangeReversal(after.find(e => e.type === 'decision_change'), after)
    expect(rev.restoreEvents).toHaveLength(1)
    expect(Math.floor(rev.restoreEvents[0].seq)).toBe(point2.seq)
    expect(rev.restoreEvents[0].seq).not.toBe(point2.seq)
  })
})

describe('a substitution added by hand: the starter re-entry rule and players sent off', () => {
  let seq = 0
  const ev = (type, setIndex, payload) => ({ id: ++seq, seq, type, setIndex, payload })
  const sub = (team, playerOut, playerIn, extra = {}) => ev('substitution', 1, { team, position: 'V', playerOut, playerIn, isExceptional: false, ...extra })
  const L = (team, lineup) => ev('lineup', 1, { team, lineup, isInitial: true })
  const players = { home: [1, 2, 3, 4, 5, 6, 9].map(number => ({ number, libero: '' })), away: [11, 12, 13, 14, 15, 16].map(number => ({ number, libero: '' })) }
  const rctx = { match: { firstServe: 'home', coinTossTeamA: 'home', coinTossTeamB: 'away' }, players }

  it('a replaced starter comes back only for his own substitute', () => {
    const events = [
      L('home', { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6 }),
      L('away', { I: 11, II: 12, III: 13, IV: 14, V: 15, VI: 16 }),
      ev('point', 1, { team: 'home' }),
      sub('home', 5, 9),
      ev('point', 1, { team: 'home' })
    ]
    expect(validateManualSubstitution(events, 'home', 1, 2, 5).legal).toBe(false)
    expect(validateManualSubstitution(events, 'home', 1, 9, 5)).toEqual({ legal: true })
    const keys = matchIssues([...events, { ...sub('home', 2, 5), position: 'II' }], rctx).map(i => i.key)
    expect(keys).toContain('corrections.issue.subStarterReturn')
  })

  it('a disqualified player does not come in', () => {
    const events = [
      L('home', { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6 }),
      L('away', { I: 11, II: 12, III: 13, IV: 14, V: 15, VI: 16 }),
      ev('sanction', 1, { team: 'home', type: 'disqualification', playerType: 'player', playerNumber: 9 }),
      ev('point', 1, { team: 'away' })
    ]
    expect(validateManualSubstitution(events, 'home', 1, 5, 9).legal).toBe(false)
    const keys = matchIssues([...events, sub('home', 5, 9)], rctx).map(i => i.key)
    expect(keys).toContain('corrections.issue.subSentOff')
  })
})
