import { describe, it, expect } from 'vitest'
import {
  scoreTimeline, insertionAt, applyPlanToEvents, planAddTimeout, planRemoveTimeout, planAddSubstitution,
  planRemoveSubstitution, planAddSanction, planRemoveSanction, planAdjustFinalScore, planSetTimes,
  planRemoveGroup, planEditEvent, planMoveEvent, planRotateTeam, courtAt, errorText, describeRemoval, isRemovableEntry
} from '../manualCorrections'
import { scoreBeforeEvent, compareBySeq, tsMs } from '../describe'
import { scoreFromPointEvents } from '../rules'
import { validateMemberSanction } from '../sanctions'
import { getScoreBeforeEvent } from '../../../scoresheet_pdf/utils/scoresheetModel'
import { buildMatch, MATCH, HOME_TEAM, AWAY_TEAM, pointsFor } from './fixtures/correctionsMatch'

const review = { match: MATCH, homeTeam: HOME_TEAM, awayTeam: AWAY_TEAM, matchId: 1, mode: 'review' }
const live = { ...review, mode: 'live', liveSetIndex: 2 }

// Set 1 25:20 (finished), set 2 in progress 12:10
function fixture() {
  return buildMatch({
    sets: [
      { points: pointsFor(25, 20), finished: true, extras: [{ at: 4, type: 'timeout', payload: { team: 'away' } }] },
      { points: pointsFor(12, 10).slice(0, 22), finished: false }
    ]
  })
}

const idxOf = (tl, home, away) => tl.findIndex(x => x.home === home && x.away === away)
const added = (after, plan, type) => after.find(e => e.id === plan.add.find(r => r.type === type).tempKey)
const baseOf = (e) => Math.floor(e.seq || 0)

describe('scoreTimeline', () => {
  it('lists every score the set went through, 0:0 first', () => {
    const { events } = fixture()
    const tl = scoreTimeline(events, 1)
    expect(tl).toHaveLength(46)
    expect(tl[0]).toMatchObject({ home: 0, away: 0 })
    expect(tl[45]).toMatchObject({ home: 25, away: 20 })
    // 0:0 is anchored after the starting line-ups, before the first rally
    const anchor = events.find(e => e.id === tl[0].anchorId)
    expect(anchor.type).toBe('lineup')
    expect(anchor.payload.isInitial).toBe(true)
    expect(tl[4].kinds).toContain('timeout')
  })
})

describe('insertion: integer seq, renumbering, ts order', () => {
  it('a forgotten time-out at 12:10 prints at 12:10 (domain and scoresheet model)', () => {
    const { events } = fixture()
    const tl = scoreTimeline(events, 1)
    const at = idxOf(tl, 12, 10)
    const plan = planAddTimeout(events, { setIndex: 1, team: 'home', at }, review)
    expect(plan.error).toBeUndefined()
    const after = applyPlanToEvents(events, plan)
    const to = added(after, plan, 'timeout')
    expect(Number.isInteger(to.seq)).toBe(true)
    expect(scoreBeforeEvent(after, to)).toEqual({ home: 12, away: 10 })
    expect(getScoreBeforeEvent(after, to)).toEqual({ home: 12, away: 10 })
    expect(plan.log.text).toBe('Added: Time-out · VC Smash (A) · Set 1 · A 12:10 B (entered after the match)')
  })

  it('shifts every later event by one and keeps each point with its N.x rows', () => {
    const { events } = fixture()
    const tl = scoreTimeline(events, 1)
    const ins = insertionAt(events, 1, idxOf(tl, 12, 10), tl)
    expect(ins.renumber.length).toBeGreaterThan(50)
    const plan = planAddTimeout(events, { setIndex: 1, team: 'home', at: idxOf(tl, 12, 10) }, review)
    const after = applyPlanToEvents(events, plan)
    // every rotation line-up still shares the base seq of its point
    for (const lu of after.filter(e => e.type === 'lineup' && !Number.isInteger(e.seq))) {
      const parent = after.find(e => e.type === 'point' && baseOf(e) === baseOf(lu))
      expect(parent).toBeTruthy()
    }
    // no two main events share a base seq
    const bases = after.filter(e => Number.isInteger(e.seq)).map(e => e.seq)
    expect(new Set(bases).size).toBe(bases.length)
    // ordering by ts (the point handler and quick lists use it) matches seq
    const set1 = after.filter(e => e.setIndex === 1 && Number.isInteger(e.seq)).sort(compareBySeq)
    for (let i = 1; i < set1.length; i++) expect(tsMs(set1[i].ts)).toBeGreaterThanOrEqual(tsMs(set1[i - 1].ts))
    // the set scores are unchanged
    expect(scoreFromPointEvents(after, 1)).toEqual({ homePoints: 25, awayPoints: 20 })
    expect(scoreFromPointEvents(after, 2)).toEqual(scoreFromPointEvents(events, 2))
  })

  it('inserts at 0:0 before the first rally and never after the set end', () => {
    const { events } = fixture()
    const tl = scoreTimeline(events, 1)
    let plan = planAddTimeout(events, { setIndex: 1, team: 'away', at: 0 }, review)
    let after = applyPlanToEvents(events, plan)
    let to = added(after, plan, 'timeout')
    const firstRally = after.filter(e => e.setIndex === 1 && e.type === 'rally_start').sort(compareBySeq)[0]
    expect(to.seq).toBeLessThan(firstRally.seq)
    plan = planAddTimeout(events, { setIndex: 1, team: 'home', at: tl.length - 1 }, review)
    after = applyPlanToEvents(events, plan)
    to = added(after, plan, 'timeout')
    const setEnd = after.find(e => e.type === 'set_end' && e.setIndex === 1)
    expect(to.seq).toBeLessThan(setEnd.seq)
    expect(scoreBeforeEvent(after, to)).toEqual({ home: 25, away: 20 })
  })

  it('refuses a third time-out and an unknown score', () => {
    const { events } = fixture()
    const one = applyPlanToEvents(events, planAddTimeout(events, { setIndex: 1, team: 'away', at: 10 }, review))
    const third = planAddTimeout(one, { setIndex: 1, team: 'away', at: 12 }, review)
    expect(third.error).toBe('corrections.error.timeoutLimit')
    expect(errorText(third)).toBe('Both time-outs of this team are already recorded in set 1.')
    expect(planAddTimeout(events, { setIndex: 1, team: 'home', at: 99 }, review).error).toBe('corrections.error.noSuchScore')
  })

  it('moves a time-out to another score, keeping its row', () => {
    const { events } = fixture()
    const to = events.find(e => e.type === 'timeout')
    const tl = scoreTimeline(events, 1)
    const plan = planMoveEvent(events, to.id, { setIndex: 1, at: idxOf(tl, 20, 16) }, review)
    expect(plan.error).toBeUndefined()
    expect(plan.add).toHaveLength(0)
    expect(plan.remove).toHaveLength(0)
    const after = applyPlanToEvents(events, plan)
    const moved = after.find(e => e.id === to.id)
    expect(scoreBeforeEvent(after, moved)).toEqual({ home: 20, away: 16 })
    expect(plan.log.text).toMatch(/^Changed: Time-out · Volley Bern \(B\) · Set 1 · B 16:20 A \(was: Time-out · Volley Bern \(B\) · Set 1 · B \d+:\d+ A\)/)
    expect(planRemoveTimeout(events, to.id, review).remove).toEqual([to.id])
  })
})

describe('substitutions', () => {
  it('a substitution inserted mid-set updates the later rotations', () => {
    const { events } = fixture()
    const tl = scoreTimeline(events, 1)
    const at = idxOf(tl, 10, 8)
    const court = courtAt(events, 1, 'home', at).lineup
    const out = court.III
    const plan = planAddSubstitution(events, { setIndex: 1, team: 'home', playerOut: out, playerIn: 9, at }, review)
    expect(plan.error).toBeUndefined()
    const after = applyPlanToEvents(events, plan)
    const sub = added(after, plan, 'substitution')
    expect(sub.payload).toMatchObject({ team: 'home', position: 'III', playerOut: out, playerIn: 9, isExceptional: false })
    const lu = after.find(e => e.type === 'lineup' && baseOf(e) === sub.seq)
    expect(lu.payload.fromSubstitution).toBe(true)
    expect(lu.payload.lineup.III).toBe(9)
    // every later home line-up in set 1 has 9 instead of the player out
    const later = after.filter(e => e.type === 'lineup' && e.setIndex === 1 && e.payload.team === 'home' && e.seq > sub.seq)
    expect(later.length).toBeGreaterThan(0)
    for (const e of later) {
      const nums = Object.values(e.payload.lineup).map(String)
      expect(nums).toContain('9')
      expect(nums).not.toContain(String(out))
    }
    // set 2 untouched
    expect(after.filter(e => e.setIndex === 2 && e.type === 'lineup').every(e => !Object.values(e.payload.lineup).includes(9))).toBe(true)
    expect(getScoreBeforeEvent(after, sub)).toEqual({ home: 10, away: 8 })
  })

  it('removing it again restores the line-ups (inverse plans)', () => {
    const { events } = fixture()
    const tl = scoreTimeline(events, 1)
    const at = idxOf(tl, 10, 8)
    const out = courtAt(events, 1, 'home', at).lineup.III
    const p1 = planAddSubstitution(events, { setIndex: 1, team: 'home', playerOut: out, playerIn: 9, at }, review)
    const withSub = applyPlanToEvents(events, p1).map(e => (e.tempKey ? { ...e, id: e.tempKey } : e))
    const sub = withSub.find(e => e.type === 'substitution')
    const p2 = planRemoveSubstitution(withSub, sub.id, review)
    const back = applyPlanToEvents(withSub, p2)
    const lineups = (list) => list.filter(e => e.type === 'lineup' && e.setIndex === 1).sort(compareBySeq).map(e => Object.values(e.payload.lineup).map(String).join(','))
    expect(lineups(back)).toEqual(lineups(events))
  })

  it('refuses a player not on court, a player already on court and a libero replacement', () => {
    const { events } = fixture()
    const tl = scoreTimeline(events, 1)
    const at = idxOf(tl, 5, 4)
    const lu = courtAt(events, 1, 'home', at).lineup
    expect(planAddSubstitution(events, { setIndex: 1, team: 'home', playerOut: 9, playerIn: 7, at }, review).error).toBe('corrections.error.playerNotOnCourt')
    expect(planAddSubstitution(events, { setIndex: 1, team: 'home', playerOut: lu.I, playerIn: lu.II, at }, review).error).toBe('corrections.error.playerInOnCourt')

    // libero #2 replaces the player in V before 5:4
    const withLibero = events.map(e => {
      if (e.type === 'lineup' && e.setIndex === 1 && e.payload.team === 'home' && e.seq < tl[at].anchorSeq + 1) {
        return e
      }
      return e
    })
    const last = withLibero.filter(e => e.type === 'lineup' && e.setIndex === 1 && e.payload.team === 'home' && Math.floor(e.seq) <= Math.floor(tl[at].anchorSeq)).sort(compareBySeq).pop()
    const replaced = last.payload.lineup.V
    last.payload = { ...last.payload, lineup: { ...last.payload.lineup, V: 2 }, liberoSubstitution: { position: 'V', liberoNumber: 2, playerNumber: replaced } }
    const r = planAddSubstitution(withLibero, { setIndex: 1, team: 'home', playerOut: replaced, playerIn: 9, at }, review)
    expect(r.error).toBe('corrections.error.liberoOnCourt')
    expect(errorText(r)).toBe(`At A 5:4 B, #${replaced} was replaced by libero #2.`)

    // the libero on court is never substituted, and the player he replaced
    // cannot come in by a substitution while the libero is on court for him
    const libOut = planAddSubstitution(withLibero, { setIndex: 1, team: 'home', playerOut: 2, playerIn: 9, at }, review)
    expect(libOut.error).toBe('corrections.error.liberoNotSubstituted')
    expect(errorText(libOut)).toMatch(/^#2 is a libero/)
    const replacedIn = planAddSubstitution(withLibero, { setIndex: 1, team: 'home', playerOut: last.payload.lineup.I, playerIn: replaced, at }, review)
    expect(replacedIn.error).toBe('corrections.error.liberoOnCourt')
  })

  it('refuses a roster libero as player in or out (ctx.liberos)', () => {
    const { events } = fixture()
    const tl = scoreTimeline(events, 1)
    const at = idxOf(tl, 5, 4)
    const lu = courtAt(events, 1, 'home', at).lineup
    const r = planAddSubstitution(events, { setIndex: 1, team: 'home', playerOut: lu.I, playerIn: 9, at }, { ...review, liberos: { home: [9], away: [] } })
    expect(r.error).toBe('corrections.error.liberoNotSubstituted')
    expect(planAddSubstitution(events, { setIndex: 1, team: 'home', playerOut: lu.I, playerIn: 9, at }, review).error).toBeUndefined()
  })

  it('refuses when a later substitution involves either player', () => {
    const { events } = buildMatch({
      sets: [{ points: pointsFor(25, 20), finished: true, extras: [{ at: 15, type: 'substitution', payload: { team: 'home', playerOut: 4, playerIn: 9 } }] }]
    })
    const tl = scoreTimeline(events, 1)
    const at = idxOf(tl, 3, 2)
    const lu = courtAt(events, 1, 'home', at).lineup
    const out = Object.values(lu).find(n => n === 4) ?? lu.I
    const r = planAddSubstitution(events, { setIndex: 1, team: 'home', playerOut: out, playerIn: 9, at }, review)
    expect(r.error).toBe('corrections.error.laterConflict')
  })

  it('an exceptional substitution writes the Swiss remark, concerned team first', () => {
    const { events } = fixture()
    const tl = scoreTimeline(events, 1)
    const at = idxOf(tl, 10, 8)
    const lu = courtAt(events, 1, 'away', at).lineup
    const plan = planAddSubstitution(events, { setIndex: 1, team: 'away', playerOut: lu.II, playerIn: 7, at, exceptional: true, reason: 'injury' }, review)
    expect(plan.remarkAdd).toEqual([`Team B, Set 1, Result 8:10: player no. ${lu.II} is exceptionally substituted by player no. 7 due to injury.`])
    const sub = plan.add.find(r => r.type === 'substitution')
    expect(sub.payload.autoRemark).toBe(plan.remarkAdd[0])
  })
})

describe('sanctions', () => {
  it('a penalty marks the next opponent point (no score change)', () => {
    const { events } = fixture()
    const tl = scoreTimeline(events, 1)
    const plan = planAddSanction(events, { setIndex: 1, team: 'home', type: 'penalty', target: { playerType: 'bench', playerNumber: 8 }, at: idxOf(tl, 11, 9) }, review)
    expect(plan.error).toBeUndefined()
    expect(plan.affectedSets).toEqual([])
    expect(plan.notes.map(n => n.text)).toContain("Volley Bern's point at B 10:11 A becomes the circled penalty point.")
    const row = plan.add[0]
    expect(row.payload).toEqual({ team: 'home', type: 'penalty', playerType: 'bench', playerNumber: 8 })
  })

  it('refuses a penalty when the opponent has no later point in the set', () => {
    const { events } = fixture()
    const tl = scoreTimeline(events, 1)
    const r = planAddSanction(events, { setIndex: 1, team: 'home', type: 'delay_penalty', at: tl.length - 1 }, review)
    // home's first delay is a warning: at match end a warning note, the point check still applies
    expect(r.error).toBe('corrections.error.noLaterOpponentPoint')
  })

  it('"add the point now" only at the live score of the set being played', () => {
    const { events } = fixture()
    const tl2 = scoreTimeline(events, 2)
    const ok = planAddSanction(events, { setIndex: 2, team: 'away', type: 'penalty', target: { playerType: 'player', playerNumber: 12 }, at: tl2.length - 1, pointAlreadyGiven: false }, live)
    expect(ok.error).toBeUndefined()
    expect(ok.followUp).toEqual({ awardPointTo: 'home' })
    expect(ok.add[0].payload.position).toBeTruthy()
    const no = planAddSanction(events, { setIndex: 2, team: 'away', type: 'penalty', target: { playerType: 'player', playerNumber: 12 }, at: 3, pointAlreadyGiven: false }, live)
    expect(no.error).toBe('corrections.error.pointNowOnlyLive')
  })

  it('the delay ladder blocks during the match and warns at the match end', () => {
    const { events } = buildMatch({
      sets: [{ points: pointsFor(25, 20), finished: true, extras: [{ at: 2, type: 'sanction', payload: { team: 'home', type: 'delay_warning' } }] }]
    })
    const tl = scoreTimeline(events, 1)
    const args = { setIndex: 1, team: 'home', type: 'delay_warning', at: idxOf(tl, 10, 8) }
    expect(planAddSanction(events, args, { ...review, mode: 'live', liveSetIndex: 1 }).error).toBe('corrections.error.ladder')
    const atEnd = planAddSanction(events, args, review)
    expect(atEnd.error).toBeUndefined()
    expect(atEnd.notes[0].text).toBe('By the rules this would have been a delay penalty; recorded as the referee decided.')
  })

  it('a member cannot get the same sanction twice; only one warning per team', () => {
    const prior = [{ type: 'sanction', payload: { team: 'home', type: 'warning', playerNumber: 5 } }]
    expect(validateMemberSanction(prior, { team: 'home', playerNumber: 5, type: 'warning' })).toEqual({ legal: false, reason: 'sameSanctionTwice' })
    expect(validateMemberSanction(prior, { team: 'home', playerNumber: 7, type: 'warning' })).toEqual({ legal: false, reason: 'teamAlreadyWarned' })
    expect(validateMemberSanction(prior, { team: 'home', playerNumber: 5, type: 'penalty' })).toEqual({ legal: true })
    expect(validateMemberSanction(prior, { team: 'away', role: 'Coach', type: 'warning' })).toEqual({ legal: true })
  })

  it('an improper request explains the paper box', () => {
    const { events } = fixture()
    const plan = planAddSanction(events, { setIndex: 1, team: 'away', type: 'improper_request', at: 3 }, review)
    expect(plan.notes.map(n => n.text)).toContain("Team B's letter is crossed (X) in the improper-request box; no score is written.")
    expect(plan.add[0].payload).toEqual({ team: 'away', type: 'improper_request' })
  })

  it('removing a penalty keeps the point unless it is the last point of the live set', () => {
    const { events } = fixture()
    const tl2 = scoreTimeline(events, 2)
    const p = planAddSanction(events, { setIndex: 2, team: 'away', type: 'penalty', target: { playerType: 'player', playerNumber: 12 }, at: tl2.length - 2 }, live)
    expect(p.error).toBeUndefined()
    const withPen = applyPlanToEvents(events, p).map(e => (e.tempKey ? { ...e, id: e.tempKey } : e))
    const pen = withPen.find(e => e.type === 'sanction')
    const keep = planRemoveSanction(withPen, pen.id, {}, live)
    expect(keep.remove).toEqual([pen.id])
    expect(keep.notes[0].text).toBe('The point stays as a normal rally point (no longer circled).')
    // the circled point is home's next point: only removable when it is the last point
    const r = planRemoveSanction(withPen, pen.id, { removePoint: true }, live)
    const points2 = withPen.filter(e => e.setIndex === 2 && e.type === 'point').sort(compareBySeq)
    if (points2[points2.length - 1].payload.team === 'home') {
      expect(r.affectedSets).toEqual([2])
    } else {
      expect(r.error).toBe('corrections.error.removePointNotLast')
    }
  })
})

describe('final score', () => {
  it('appends a point before the set end with the side-out rotation', () => {
    const { events, sets } = buildMatch({ sets: [{ points: pointsFor(25, 22), finished: true }] })
    const plan = planAdjustFinalScore(events, sets, { setIndex: 1, team: 'away', delta: 1 }, review)
    expect(plan.error).toBeUndefined()
    expect(plan.affectedSets).toEqual([1])
    const after = applyPlanToEvents(events, plan)
    expect(scoreFromPointEvents(after, 1)).toEqual({ homePoints: 25, awayPoints: 23 })
    const point = added(after, plan, 'point')
    const setEnd = after.find(e => e.type === 'set_end')
    expect(point.seq).toBeLessThan(setEnd.seq)
    const rot = after.find(e => e.type === 'lineup' && baseOf(e) === point.seq)
    expect(rot.payload.team).toBe('away')
    // the set still ends on the winner's point: the missed point of the
    // loser goes in before it (24:22 -> 24:23 -> 25:23), never after 25:22
    const pts = after.filter(e => e.type === 'point' && e.setIndex === 1).sort(compareBySeq)
    expect(pts[pts.length - 1].payload.team).toBe('home')
    expect(pts[pts.length - 2].id).toBe(point.id)
    expect(scoreBeforeEvent(after, point)).toEqual({ home: 24, away: 22 })
    expect(point.payload.score).toEqual({ home: 24, away: 23 })
    // the winning point is now a side-out: it rotates the winner
    const win = pts[pts.length - 1]
    const winRot = after.filter(e => e.type === 'lineup' && baseOf(e) === baseOf(win) && e.seq !== win.seq)
    expect(winRot.map(e => e.payload.team)).toEqual(['home'])
    const homeBefore = events.filter(e => e.type === 'lineup' && e.payload.team === 'home').sort(compareBySeq).pop().payload.lineup
    expect(winRot[0].payload.lineup.I).toBe(homeBefore.II)
    // one row per seq, none after the set end
    const seqs = after.map(e => e.seq)
    expect(new Set(seqs).size).toBe(seqs.length)
    expect(after.filter(e => e.seq > setEnd.seq)).toHaveLength(0)
  })

  it('guards the winner and the possible final scores', () => {
    const { events, sets } = buildMatch({ sets: [{ points: pointsFor(25, 23), finished: true }] })
    expect(planAdjustFinalScore(events, sets, { setIndex: 1, team: 'away', delta: 1 }, review).error).toBe('corrections.error.winnerWouldChange')
    expect(planAdjustFinalScore(events, sets, { setIndex: 1, team: 'home', delta: 1 }, review).error).toBe('corrections.error.invalidFinalScore')
    expect(planAdjustFinalScore(events, sets, { setIndex: 1, team: 'home', delta: -1 }, review).error).toBe('corrections.error.winnerWouldChange')
    expect(planAdjustFinalScore(events, sets, { setIndex: 1, team: 'away', delta: -1 }, review).error).toBe('corrections.error.notLastPoint')
  })

  it('removes an extra last point (26:20 -> 25:20)', () => {
    const { events, sets } = buildMatch({ sets: [{ points: `${pointsFor(25, 20)}H`, finished: true }] })
    const plan = planAdjustFinalScore(events, sets, { setIndex: 1, team: 'home', delta: -1 }, review)
    expect(plan.error).toBeUndefined()
    const after = applyPlanToEvents(events, plan)
    expect(scoreFromPointEvents(after, 1)).toEqual({ homePoints: 25, awayPoints: 20 })
    // the rally start of that point went too
    expect(after.filter(e => e.type === 'rally_start').length).toBe(45)
  })

  it('refuses an unfinished set', () => {
    const { events, sets } = fixture()
    expect(planAdjustFinalScore(events, sets, { setIndex: 2, team: 'home', delta: 1 }, review).error).toBe('corrections.error.setNotFinished')
  })
})

describe('set times, rotation, advanced removal', () => {
  it('corrects the set row and the set end, suggests a delayed-start remark', () => {
    const { events, sets } = fixture()
    const start = new Date(Date.parse(sets[0].endTime) + 9 * 60000).toISOString()
    const plan = planSetTimes(events, sets, { setIndex: 2, startTime: start }, review)
    expect(plan.setUpdates).toEqual([{ setIndex: 2, changes: { startTime: start } }])
    expect(plan.suggestedRemark).toMatch(/^Set 2 start time \d\d:\d\d \(9' delay\) due to/)
    const p1 = planSetTimes(events, sets, { setIndex: 1, endTime: sets[0].endTime }, review)
    const end = events.find(e => e.type === 'set_end')
    expect(p1.update[0].id).toBe(end.id)
  })

  it('rotates a team one position at the current score', () => {
    const { events } = fixture()
    const plan = planRotateTeam(events, { setIndex: 2, team: 'home', direction: 1 }, live)
    expect(plan.error).toBeUndefined()
    expect(plan.after.I).toBe(plan.before.II)
    const back = planRotateTeam(events, { setIndex: 2, team: 'home', direction: -1 }, live)
    expect(back.after.II).toBe(back.before.I)
  })

  it('removes a point with its rotation and rally start, refuses a set end', () => {
    const { events } = fixture()
    // a side-out point of the loser of set 1 (25:20 -> 25:19 stays a possible result)
    const sidePoint = events.find(e => e.type === 'point' && e.setIndex === 1 && e.payload.team === 'away' && events.some(x => x.type === 'lineup' && baseOf(x) === e.seq && x.seq !== e.seq))
    const plan = planRemoveGroup(events, sidePoint.id, review)
    expect(plan.remove).toHaveLength(3)
    expect(plan.affectedSets).toEqual([1])
    expect(plan.notes[0].text).toBe('Later rotations of this set are not recalculated.')
    expect(describeRemoval(events, plan, review)[0]).toMatch(/^Point for /)
    expect(planRemoveGroup(events, events.find(e => e.type === 'set_end').id, review).error).toBe('corrections.error.useUndo')
  })

  it('never leaves a finished set with an impossible result or another winner', () => {
    const { events } = fixture()
    // set 1 is 25:20: a point of the winner removed would leave 24:20
    const winnerPoint = events.find(e => e.type === 'point' && e.setIndex === 1 && e.payload.team === 'home')
    const r = planRemoveGroup(events, winnerPoint.id, review)
    expect(r.error).toBe('corrections.error.winnerWouldChange')
    // the set being played has no final score yet: a point may go
    const livePoint = events.find(e => e.type === 'point' && e.setIndex === 2 && e.payload.team === 'home')
    expect(planRemoveGroup(events, livePoint.id, live).error).toBeUndefined()
    // 26:24 -> 26:23 is not a final score
    const { events: tight } = buildMatch({ sets: [{ points: pointsFor(26, 24), finished: true }] })
    const loser = tight.find(e => e.type === 'point' && e.payload.team === 'away')
    expect(planRemoveGroup(tight, loser.id, review).error).toBe('corrections.error.invalidFinalScore')
  })

  it('offers Remove in the advanced log only for removable rows', () => {
    const { events } = fixture()
    expect(isRemovableEntry(events.find(e => e.type === 'lineup' && e.payload.isInitial))).toBe(false)
    expect(isRemovableEntry(events.find(e => e.type === 'set_end'))).toBe(false)
    expect(isRemovableEntry(events.find(e => e.type === 'lineup' && !Number.isInteger(e.seq)))).toBe(false)
    expect(isRemovableEntry(events.find(e => e.type === 'point'))).toBe(true)
    expect(isRemovableEntry(events.find(e => e.type === 'timeout'))).toBe(true)
  })

  it('edits a sanction type in place', () => {
    const { events } = buildMatch({
      sets: [{ points: pointsFor(25, 20), finished: true, extras: [{ at: 5, type: 'sanction', payload: { team: 'away', type: 'warning', playerType: 'player', playerNumber: 12 } }] }]
    })
    const s = events.find(e => e.type === 'sanction')
    const tl = scoreTimeline(events, 1)
    const at = tl.findIndex(x => x.kinds.includes('sanction'))
    const plan = planEditEvent(events, s.id, { type: 'expulsion', target: { playerType: 'player', playerNumber: 12 }, at }, review)
    expect(plan.error).toBeUndefined()
    const after = applyPlanToEvents(events, plan)
    expect(after.find(e => e.id === s.id).payload.type).toBe('expulsion')
    expect(plan.log.text).toMatch(/^Changed: Expulsion — Player #12/)
  })
})
