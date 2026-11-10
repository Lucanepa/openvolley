// Going back in the game (domain/rectify): the score where it went wrong,
// whose points since then are cancelled (A, B, both) and who gets point and
// service; then everything edited by hand before play resumes (the score,
// who serves, both line-ups, a substitution taken back, the remark), all of
// it one correction that is taken back as a whole.
import { describe, it, expect } from 'vitest'
import { buildMatch, MATCH, HOME_TEAM, AWAY_TEAM, pointsFor } from './fixtures/correctionsMatch'
import { rectifyMoments, planRectification, planRectificationReversal, defaultPenaltyTo, lineupNow } from '../rectify'
import { applyPlanToEvents, planRemoveEntry, entryActions } from '../manualCorrections'
import { recomputeMatch, finalizePlan } from '../recompute'
import { scoreFromPointEvents, servingTeamFromLog } from '../rules'
import { describeEvent, compareBySeq } from '../describe'
import { trackServiceRounds } from '../../../scoresheet_pdf/utils/serviceRounds'
import { getStartingLineup, rectificationServerColumn, getFirstServeTeamKey } from '../../../scoresheet_pdf/utils/scoresheetModel'

const LIVE = { ...MATCH, status: 'live' }
const ctxFor = (setIndex = 2) => ({ match: LIVE, homeTeam: HOME_TEAM, awayTeam: AWAY_TEAM, matchId: 1, liveSetIndex: setIndex, now: new Date('2026-10-03T20:00:00Z') })

/** Set 1 finished 25:20, set 2 in progress with `points` and `extras`. */
function liveMatch(points, extras = []) {
  return buildMatch({ match: LIVE, sets: [{ points: pointsFor(25, 20), finished: true }, { points, finished: false, extras }] })
}
const score = (events, setIndex = 2) => {
  const s = scoreFromPointEvents(events, setIndex)
  return `${s.homePoints}:${s.awayPoints}`
}
const at = (events, h, a) => rectifyMoments(events, { setIndex: 2 }, ctxFor()).find(m => m.score.home === h && m.score.away === a)
const plan = (events, opts) => planRectification(events, { setIndex: 2, ...opts }, ctxFor())
const withIds = (list) => list.map((e, i) => (typeof e.id === 'string' ? { ...e, id: 9000 + i } : e))
const unchangedByRebuild = (after) => {
  const again = recomputeMatch(after, ctxFor())
  return again.add.length + again.update.length + again.remove.length === 0
}

// set 2 (away serves first): 1:1, home #7 in for #4, then H H A H A H -> home 5:3
const subMatch = () => liveMatch('HA' + 'HHAHAH', [{ at: 2, type: 'substitution', payload: { team: 'home', playerOut: 4, playerIn: 7 } }])

describe('rectify: when', () => {
  it('offers the scores of the set, newest first, the set start last', () => {
    const { events } = liveMatch('HHA')
    const moments = rectifyMoments(events, { setIndex: 2 }, ctxFor())
    expect(moments.map(m => m.label)).toEqual(['A 2:1 B', 'A 2:0 B', 'A 1:0 B', 'Start of the set (A 0:0 B)'])
  })

  it('the usual answer to "point and service to": the opponent of the team at fault, nobody for both', () => {
    expect(defaultPenaltyTo('home')).toBe('away')
    expect(defaultPenaltyTo('away')).toBe('home')
    expect(defaultPenaltyTo('both')).toBeNull()
  })
})

describe('rectify: one team\'s points cancelled (R15.9.2, 7.3.5.3, 7.7.2)', () => {
  it('illegal substitution found later: the team\'s points since then cancelled, the opponent keeps its points and gains point and service', () => {
    const { events } = subMatch()
    expect(score(events)).toBe('5:3')
    const p = plan(events, { moment: at(events, 1, 1), cancel: 'home', penaltyTo: 'away', kind: 'illegal_substitution' })
    expect(p.error).toBeUndefined()
    const after = applyPlanToEvents(events, p)
    expect(score(after)).toBe('1:4')
    expect(after.filter(e => e.type === 'cancelled_point')).toHaveLength(4)
    expect(p.preview.serve).toBe('away')
    expect(servingTeamFromLog(after, 2, LIVE)).toBe('away')
    // home was serving: the penalty point is a side-out, the opponent rotates
    const penalty = after.find(e => e.type === 'point' && e.payload?.rectification)
    expect(after.some(e => e.type === 'lineup' && Math.floor(e.seq) === penalty.seq && e.payload.team === 'away')).toBe(true)
    // the head is the newest entry and carries the remark
    const head = after.filter(e => e.setIndex === 2 && e.seq === Math.floor(e.seq)).sort(compareBySeq).pop()
    expect(head.type).toBe('rectification')
    // the auto remark, owner's template, the team at fault first
    expect(p.remarkAdd[0]).toBe('Set 2, points 5:3: illegal substitution by team A (since 1:1, 4 points of team A cancelled, point and service to team B). New score for set 2: 1:4.')
    // the penalty point is circled on the sheet like a sanction's
    expect(penalty.payload.penaltyPoint).toBe(true)
    expect(head.payload.autoRemark).toBe(p.remarkAdd[0])
    // a cancelled point is still a rally: the rebuild finds nothing to change
    expect(unchangedByRebuild(after)).toBe(true)
  })

  it('positions not as on the line-up sheet since 0:0, found at 5:7: play goes on at 0:8 (SSK note)', () => {
    const { events } = liveMatch('HAHAHAHAHAAA')
    const start = rectifyMoments(events, { setIndex: 2 }, ctxFor()).pop()
    const p = plan(events, { moment: start, cancel: 'home', penaltyTo: 'away' })
    expect(score(applyPlanToEvents(events, p))).toBe('0:8')
  })

  it('nothing to cancel and nobody to give the point: nothing to write', () => {
    const { events } = liveMatch('HA')
    expect(plan(events, { moment: at(events, 1, 1), cancel: 'home', penaltyTo: null }).error).toBe('rectify.error.nothingToChange')
  })

  it('refuses a finished set and another set than the one being played', () => {
    const { events } = subMatch()
    const moment = { boundarySeq: -Infinity, score: { home: 0, away: 0 } }
    expect(planRectification(events, { setIndex: 1, moment, cancel: 'home' }, { ...ctxFor(), liveSetIndex: 1 }).error).toBe('rectify.error.setFinished')
    expect(planRectification(events, { setIndex: 1, moment, cancel: 'home' }, ctxFor()).error).toBe('rectify.error.notLive')
    expect(plan(events, { moment: at(events, 1, 1), cancel: null }).error).toBe('rectify.error.chooseCancel')
  })
})

describe('rectify: both, officials\' mistake (CB 2.3, 2.4)', () => {
  const build = () => liveMatch('HHAAHA', [
    { at: 3, type: 'timeout', payload: { team: 'away' } },
    { at: 4, type: 'sanction', payload: { team: 'away', type: 'warning', playerType: 'player', playerNumber: 12 } }
  ])

  it('takes the rallies since that score out for both teams; time-outs and sanctions stay; the teams back on their line-ups of that moment', () => {
    const { events } = build()
    const moment = at(events, 2, 0)
    const p = plan(events, { moment, cancel: 'both', penaltyTo: null })
    const after = applyPlanToEvents(events, p)
    expect(score(after)).toBe('2:0')
    expect(after.some(e => e.type === 'timeout' && e.setIndex === 2)).toBe(true)
    expect(after.some(e => e.type === 'sanction' && e.setIndex === 2)).toBe(true)
    expect(p.preview.serve).toBe('home')
    expect(lineupNow(after, 2, 'away').lineup).toEqual(lineupNow(events.filter(e => (e.seq || 0) <= moment.boundarySeq), 2, 'away').lineup)
    expect(p.notes.map(n => n.key)).toContain('rectify.note.timeline')
    expect(p.remarkAdd[0]).toBe('Set 2, points 3:3: officials\' mistake (both teams\' points since 2:0 cancelled, no point). New score for set 2: 2:0.')
    expect(p.rectification.kind).toBe('officials_mistake')
  })

  it('is taken back while it is the newest entry: the rallies come back', () => {
    const { events } = build()
    const p = plan(events, { moment: at(events, 2, 0), cancel: 'both', penaltyTo: null })
    const after = withIds(applyPlanToEvents(events, p))
    const head = after.find(e => e.type === 'rectification')
    const back = planRectificationReversal(after, head.id, ctxFor())
    expect(back.error).toBeUndefined()
    const restored = applyPlanToEvents(after, back)
    expect(score(restored)).toBe('3:3')
    expect(lineupNow(restored, 2, 'away').lineup).toEqual(lineupNow(events, 2, 'away').lineup)
    const later = [...after, { id: 9999, matchId: 1, setIndex: 2, type: 'point', seq: head.seq + 1, ts: head.ts, payload: { team: 'home' } }]
    expect(planRectificationReversal(later, head.id, ctxFor()).error).toBe('rectify.error.notLast')
  })

  it('one going back at a time: the scores before it are not offered', () => {
    const { events } = build()
    const after = withIds(applyPlanToEvents(events, plan(events, { moment: at(events, 2, 2), cancel: 'both', penaltyTo: null })))
    expect(rectifyMoments(after, { setIndex: 2 }, ctxFor()).map(m => `${m.score.home}:${m.score.away}`)).toEqual(['2:2'])
  })
})

describe('rectify: everything editable before play resumes', () => {
  const base = (events) => ({ moment: at(events, 1, 1), cancel: 'home', penaltyTo: 'away' })

  it('the score by hand, lower: more of the team\'s newest points cancelled, then no penalty point', () => {
    const { events } = subMatch()
    const p = plan(events, { ...base(events), edits: { score: { home: 0, away: 4 } } })
    const after = applyPlanToEvents(events, p)
    expect(score(after)).toBe('0:4')
    expect(p.preview.scoreAfter).toEqual({ home: 0, away: 4 })
    const q = plan(events, { ...base(events), edits: { score: { home: 1, away: 3 } } })
    expect(score(applyPlanToEvents(events, q))).toBe('1:3')
    expect(q.rectification.penaltyTo).toBeNull()
  })

  it('the score by hand, higher: cancelled points count again, then points by hand that pass no serve and rotate nobody', () => {
    const { events } = subMatch()
    const p = plan(events, { ...base(events), edits: { score: { home: 3, away: 6 } } })
    const after = applyPlanToEvents(events, p)
    expect(score(after)).toBe('3:6')
    expect(after.filter(e => e.type === 'cancelled_point')).toHaveLength(2)
    const byHand = after.filter(e => e.type === 'point' && e.payload?.scoreAdjusted)
    expect(byHand).toHaveLength(2)
    expect(byHand.every(e => e.payload.team === 'away')).toBe(true)
    // no rotation rows for them, the serve stays with the penalty point's team
    expect(after.some(e => e.type === 'lineup' && byHand.some(b => Math.floor(e.seq) === b.seq))).toBe(false)
    expect(servingTeamFromLog(after, 2, LIVE)).toBe('away')
    expect(unchangedByRebuild(after)).toBe(true)
    expect(plan(events, { ...base(events), edits: { score: { home: -1, away: 3 } } }).error).toBe('rectify.error.badScore')
  })

  it('who serves: the scorer\'s choice holds for the next rally, live and in the rebuild', () => {
    const { events } = subMatch()
    const p = plan(events, { ...base(events), edits: { serve: 'home' } })
    expect(p.preview.serve).toBe('home')
    const after = withIds(applyPlanToEvents(events, p))
    expect(servingTeamFromLog(after, 2, LIVE)).toBe('home')
    expect(p.remarkAdd[0]).toMatch(/point and service to team B, team A to serve\)\. New score for set 2: 1:4\.$/)
    // home keeps serving and wins the next rally: no rotation in the rebuild
    const next = [...after, { id: 9998, matchId: 1, setIndex: 2, type: 'point', seq: Math.floor(Math.max(...after.map(e => e.seq))) + 1, ts: after[0].ts, payload: { team: 'home', score: { home: 2, away: 4 } } }]
    expect(unchangedByRebuild(next)).toBe(true)
    expect(servingTeamFromLog(next, 2, LIVE)).toBe('home')
  })

  // 3.0.16 test match: "Serves next" switched by hand. The court kept the
  // team's player at position I serving (nobody rotates); the sheet opened
  // the team's next column, as if it had rotated
  it('a serve changed by hand rotates nobody: court and scoresheet name the same server', () => {
    const { events } = subMatch()
    const atI = lineupNow(events, 2, 'home').lineup.I
    const p = plan(events, { ...base(events), edits: { serve: 'home' } })
    const after = withIds(applyPlanToEvents(events, p))
    // the court: no home line-up row from the going back, the same player serves
    const head = after.find(e => e.type === 'rectification')
    expect(after.some(e => e.type === 'lineup' && e.payload?.team === 'home' && Math.floor(e.seq) >= Math.floor(head.seq))).toBe(false)
    expect(p.preview.serverNumber).toBe(atI)
    expect(lineupNow(after, 2, 'home').lineup.I).toBe(atI)

    // the scoresheet: home's open round is the column of that player
    const inSet = after.filter(e => e.setIndex === 2).sort(compareBySeq)
    const start = getStartingLineup(inSet, 2, 'home')
    const rally = inSet.filter(e => e.type === 'point' || e.type === 'cancelled_point' || e.type === 'rectification')
    const rounds = trackServiceRounds({
      pointTeams: rally.map(e => (e.type === 'rectification' ? e.payload.serve : e.payload.team)),
      counted: rally.map(e => e.type === 'point'),
      passes: rally.map(e => !(e.type === 'point' && e.payload?.scoreAdjusted === true)),
      served: rally.map(e => (e.type === 'rectification' ? rectificationServerColumn(inSet, e, start) : undefined)),
      firstServer: getFirstServeTeamKey(2, LIVE, 'home', 'away'),
      finished: false
    })
    const open = rounds.home[rounds.home.length - 1]
    expect(open.closedAt).toBeNull()
    expect(start[open.position]).toBe(String(atI))
    // the round before it (lost at 5:3) is the same column: no rotation
    expect(rounds.home[rounds.home.length - 2].position).toBe(open.position)
  })

  it('both line-ups by hand, and a substitution taken back', () => {
    const { events } = subMatch()
    const first = plan(events, base(events))
    const home = { ...first.preview.lineupState.home.lineup }
    const pos7 = Object.keys(home).find(k => home[k] === 7)
    const away = { ...first.preview.lineupState.away.lineup }
    const [a, b] = [away.I, away.II]
    const p = plan(events, { ...base(events), edits: { lineups: { home: { ...home, [pos7]: '4' }, away: { ...away, I: b, II: a } } } })
    expect(p.error).toBeUndefined()
    const after = applyPlanToEvents(events, p)
    expect(lineupNow(after, 2, 'home').lineup[pos7]).toBe(4)
    expect(lineupNow(after, 2, 'away').lineup.I).toBe(b)
    expect(p.preview.serverNumber).toBe(b)
    expect(plan(events, { ...base(events), edits: { lineups: { home: { ...home, [pos7]: '1' } } } }).error).toBe('rectify.error.lineupDuplicate')

    const sub = events.find(e => e.type === 'substitution')
    const tb = plan(events, { ...base(events), edits: { takeBack: [sub.id] } })
    const afterTb = applyPlanToEvents(events, tb)
    expect(afterTb.some(e => e.type === 'substitution' && e.setIndex === 2)).toBe(false)
    expect(Object.values(lineupNow(afterTb, 2, 'home').lineup)).toContain(4)
    expect(tb.remarkAdd[0]).toMatch(/4 points of team A cancelled, substitution #7 for #4 of team A taken back, point and service/)
    expect(tb.preview.substitutions.map(s => s.id)).toEqual([sub.id])
  })

  it('the remark as the scorer wrote it', () => {
    const { events } = subMatch()
    const p = plan(events, { ...base(events), edits: { remark: 'Team A, Set 2: illegal substitution #7 (rule 15.9.2).' } })
    expect(p.remarkAdd).toEqual(['Team A, Set 2: illegal substitution #7 (rule 15.9.2).'])
    expect(p.preview.remarkDefault).toMatch(/^Set 2, points 5:3: game taken back \(since 1:1/)
    // left empty: the app's remark is written anyway (one must exist)
    expect(plan(events, { ...base(events), edits: { remark: '   ' } }).remarkAdd).toEqual([p.preview.remarkDefault])
  })

  it('the remark words what it was, one point or none, and its new score follows a score set by hand', () => {
    const { events } = liveMatch('AAHHH')
    const wrongServer = plan(events, { moment: at(events, 1, 2), cancel: 'home', penaltyTo: 'away', kind: 'wrong_server' })
    expect(wrongServer.remarkAdd[0]).toBe('Set 2, points 3:2: wrong server of team A (since 1:2, 2 points of team A cancelled, point and service to team B). New score for set 2: 1:3.')
    const one = plan(events, { moment: at(events, 2, 2), cancel: 'home', penaltyTo: 'away', kind: 'wrong_positions' })
    expect(one.remarkAdd[0]).toMatch(/^Set 2, points 3:2: positions not as on the line-up sheet, team A \(since 2:2, 1 point of team A cancelled/)
    const none = plan(events, { moment: at(events, 3, 2), cancel: 'home', penaltyTo: 'away' })
    expect(none.remarkAdd[0]).toMatch(/\(since 3:2, no point cancelled, point and service to team B\)\. New score for set 2: 3:3\.$/)
    const byHand = plan(events, { moment: at(events, 1, 2), cancel: 'home', penaltyTo: 'away', kind: 'wrong_server', edits: { score: { home: 1, away: 4 } } })
    expect(byHand.remarkAdd[0]).toMatch(/New score for set 2: 1:4\.$/)
    // concerned team first: B at fault, B's points first
    const b = plan(events, { moment: at(events, 0, 0), cancel: 'away', penaltyTo: 'home', kind: 'illegal_substitution' })
    expect(b.remarkAdd[0]).toBe('Set 2, points 2:3: illegal substitution by team B (since 0:0, 2 points of team B cancelled, point and service to team A). New score for set 2: 0:4.')
  })

  it('all of it is taken back as one: Remove in the corrections, Undo\'s planner', () => {
    const { events } = subMatch()
    const sub = events.find(e => e.type === 'substitution')
    const p = plan(events, { ...base(events), edits: { score: { home: 3, away: 6 }, serve: 'home', takeBack: [sub.id] } })
    const after = withIds(applyPlanToEvents(events, p))
    const head = after.find(e => e.type === 'rectification')
    expect(entryActions(head, after).remove).toBe('plan')
    const back = planRemoveEntry(after, head.id, ctxFor())
    expect(back.error).toBeUndefined()
    const restored = applyPlanToEvents(after, back)
    expect(score(restored)).toBe('5:3')
    expect(restored.some(e => ['cancelled_point', 'rectification'].includes(e.type) || e.payload?.rectification)).toBe(false)
    expect(restored.some(e => e.type === 'substitution' && e.payload.playerIn === 7)).toBe(true)
    expect(Object.values(lineupNow(restored, 2, 'home').lineup)).toContain(7)
    expect(back.remarkRemove).toEqual([p.remarkAdd[0]])
    const cp = after.find(e => e.type === 'cancelled_point')
    expect(planRemoveEntry(after, cp.id, ctxFor()).error).toBe('corrections.error.cancelledPoint')
  })

  it('describes the head and a cancelled point in the words of the sheet', () => {
    const { events } = subMatch()
    const after = applyPlanToEvents(events, plan(events, base(events)))
    expect(describeEvent(after.find(e => e.type === 'rectification'), after, ctxFor()).text).toBe('Game taken back · VC Smash (A) · 4 point(s) of A cancelled, point to B · Set 2 · A 1:4 B')
    expect(describeEvent(after.find(e => e.type === 'cancelled_point'), after, ctxFor()).title).toBe('Point cancelled: VC Smash')
  })

  it('finalizing an empty plan on the result changes nothing', () => {
    const { events } = liveMatch('HHAAHH')
    const after = applyPlanToEvents(events, plan(events, { moment: at(events, 2, 2), cancel: 'home', penaltyTo: 'away' }))
    const again = finalizePlan(after, { add: [], update: [], remove: [], affectedSets: [] }, ctxFor())
    expect([again.add, again.update, again.remove, again.affectedSets]).toEqual([[], [], [], []])
  })
})
