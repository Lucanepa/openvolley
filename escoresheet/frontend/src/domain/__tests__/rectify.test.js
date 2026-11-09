// Going back in the game (domain/rectify): the FIVB situations that cancel
// the points of the team at fault since the fault (R7.3.5.3, 7.7.2, 15.9.2,
// 19.3.2.9), the officials' mistake that takes the score back for both teams
// (Casebook 2.3), the illegal entry noticed before the service (16.1.3), and
// taking each of them back.
import { describe, it, expect } from 'vitest'
import { buildMatch, MATCH, HOME_TEAM, AWAY_TEAM, pointsFor } from './fixtures/correctionsMatch'
import {
  RECTIFY_KINDS, RECTIFY_KIND_ORDER, rectifyMoments, planRectification, planRectificationReversal,
  planIllegalEntryBeforeService, entriesBeforeService, suggestedLineup, servedRallies, lineupNow
} from '../rectify'
import { applyPlanToEvents, planRemoveEntry, entryActions } from '../manualCorrections'
import { recomputeMatch, finalizePlan } from '../recompute'
import { scoreFromPointEvents } from '../rules'
import { describeEvent, compareBySeq } from '../describe'

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
const momentOf = (events, opts, pick) => rectifyMoments(events, opts, ctxFor()).find(pick)
const lastLineup = (events, team, setIndex = 2) => lineupNow(events, setIndex, team)?.lineup

describe('rectify: the situations', () => {
  it('lists every situation with its rule', () => {
    expect(RECTIFY_KIND_ORDER).toEqual(Object.keys(RECTIFY_KINDS))
    expect(RECTIFY_KINDS.illegal_substitution.refs).toMatch(/15\.9\.2/)
    expect(RECTIFY_KINDS.rotation_fault.refs).toMatch(/7\.7\.2/)
    expect(RECTIFY_KINDS.lineup_discrepancy.refs).toMatch(/7\.3\.5\.3/)
    expect(RECTIFY_KINDS.official_error.refs).toMatch(/Casebook 2\.3/)
  })
})

describe('rectify: illegal substitution found after play went on (R15.9.2, CB 4.13)', () => {
  // set 2 (away serves first): 1:1, home #7 in for #4, then H H A H A H -> home 5:3
  const build = () => liveMatch('HA' + 'HHAHAH', [{ at: 2, type: 'substitution', payload: { team: 'home', playerOut: 4, playerIn: 7 } }])

  it('offers the team\'s substitutions as moments', () => {
    const { events } = build()
    const moments = rectifyMoments(events, { kind: 'illegal_substitution', setIndex: 2, team: 'home' }, ctxFor())
    expect(moments).toHaveLength(1)
    expect(moments[0].kind).toBe('event')
    expect(moments[0].label).toMatch(/#7 in for #4 at A 1:1 B/)
  })

  it('cancels the points of the team at fault since the substitution, the opponent keeps its points and gains point and service', () => {
    const { events } = build()
    expect(score(events)).toBe('5:3')
    const moment = momentOf(events, { kind: 'illegal_substitution', setIndex: 2, team: 'home' }, m => m.kind === 'event')
    const lineup = suggestedLineup(events, { kind: 'illegal_substitution', setIndex: 2, team: 'home', moment })
    // #7 goes out, #4 comes back where #7 stands now
    expect(Object.values(lineup)).toContain(4)
    expect(Object.values(lineup)).not.toContain(7)
    const plan = planRectification(events, { kind: 'illegal_substitution', setIndex: 2, team: 'home', moment, lineup }, ctxFor())
    expect(plan.error).toBeUndefined()
    const after = applyPlanToEvents(events, plan)
    // home 5 -> 1 (its 4 points since the substitution cancelled), away 3 + 1
    expect(score(after)).toBe('1:4')
    expect(after.filter(e => e.type === 'cancelled_point')).toHaveLength(4)
    expect(plan.preview.scoreAfter).toEqual({ home: 1, away: 4 })
    expect(plan.preview.penaltyTo).toBe('away')
    expect(plan.preview.server).toBe('away')
    expect(plan.rectification).toEqual({ kind: 'illegal_substitution', setIndex: 2, team: 'home', penaltyTo: 'away' })
    // home was serving: the penalty point is a side-out, the opponent rotates
    const penalty = after.filter(e => e.type === 'point' && e.payload?.rectification === 'illegal_substitution')
    expect(penalty).toHaveLength(1)
    const rotation = after.find(e => e.type === 'lineup' && Math.floor(e.seq) === penalty[0].seq && e.payload.team === 'away')
    expect(rotation).toBeTruthy()
    // the substitution stays recorded (it counted); the line-up is put right
    expect(after.some(e => e.type === 'substitution' && e.payload.playerIn === 7)).toBe(true)
    expect(Object.values(lastLineup(after, 'home'))).toContain(4)
    // the head is the newest entry of the set and carries the remark
    const head = after.filter(e => e.setIndex === 2).sort(compareBySeq).filter(e => e.seq === Math.floor(e.seq)).pop()
    expect(head.type).toBe('rectification')
    expect(plan.remarkAdd[0]).toBe('Team A, Set 2, Result 5:3: illegal substitution (rule 15.9.2) since 1:1; 4 point(s) of team A cancelled, point and service to team B; score now 1:4.')
    expect(head.payload.autoRemark).toBe(plan.remarkAdd[0])
  })

  it('keeps every rotation: a cancelled point is still a rally (nothing to rebuild afterwards)', () => {
    const { events } = build()
    const moment = momentOf(events, { kind: 'illegal_substitution', setIndex: 2, team: 'home' }, m => m.kind === 'event')
    const plan = planRectification(events, { kind: 'illegal_substitution', setIndex: 2, team: 'home', moment }, ctxFor())
    // no rotation of the cancelled points was removed or rewritten
    const cancelledIds = new Set(plan.update.filter(u => u.changes.type === 'cancelled_point').map(u => u.id))
    const rotationOfCancelled = events.filter(e => e.type === 'lineup' && [...cancelledIds].some(id => Math.floor(e.seq) === events.find(x => x.id === id).seq))
    expect(rotationOfCancelled.length).toBeGreaterThan(0)
    expect(plan.remove.filter(id => rotationOfCancelled.some(r => r.id === id))).toEqual([])
    const after = applyPlanToEvents(events, plan)
    const again = recomputeMatch(after, ctxFor())
    expect(again.add).toEqual([])
    expect(again.update).toEqual([])
    expect(again.remove).toEqual([])
  })

  it('is taken back as a whole: Remove in the corrections, and the reversal planner', () => {
    const { events } = build()
    const moment = momentOf(events, { kind: 'illegal_substitution', setIndex: 2, team: 'home' }, m => m.kind === 'event')
    const lineup = suggestedLineup(events, { kind: 'illegal_substitution', setIndex: 2, team: 'home', moment })
    const plan = planRectification(events, { kind: 'illegal_substitution', setIndex: 2, team: 'home', moment, lineup }, ctxFor())
    const after = applyPlanToEvents(events, plan).map((e, i) => (typeof e.id === 'string' ? { ...e, id: 9000 + i } : e))
    const head = after.find(e => e.type === 'rectification')
    expect(entryActions(head, after).remove).toBe('plan')
    const back = planRemoveEntry(after, head.id, ctxFor())
    expect(back.error).toBeUndefined()
    const restored = applyPlanToEvents(after, back)
    expect(score(restored)).toBe('5:3')
    expect(restored.some(e => e.type === 'cancelled_point' || e.type === 'rectification')).toBe(false)
    expect(back.remarkRemove).toEqual([plan.remarkAdd[0]])
    expect(Object.values(lastLineup(restored, 'home'))).toContain(7)
    // same rows as before (the rotations rebuilt the same way)
    const key = (list) => list.filter(e => e.setIndex === 2 && e.type !== 'rally_start').sort(compareBySeq).map(e => `${e.type}:${e.payload?.team}:${JSON.stringify(e.payload?.lineup || '')}`)
    expect(key(restored)).toEqual(key(events))
    // a cancelled point itself is not removed on its own
    const cp = after.find(e => e.type === 'cancelled_point')
    expect(planRemoveEntry(after, cp.id, ctxFor()).error).toBe('corrections.error.cancelledPoint')
    expect(planRectificationReversal(after, head.id, ctxFor()).error).toBeUndefined()
  })

  it('describes the head and a cancelled point in the words of the sheet', () => {
    const { events } = build()
    const moment = momentOf(events, { kind: 'illegal_substitution', setIndex: 2, team: 'home' }, m => m.kind === 'event')
    const plan = planRectification(events, { kind: 'illegal_substitution', setIndex: 2, team: 'home', moment }, ctxFor())
    const after = applyPlanToEvents(events, plan)
    const head = after.find(e => e.type === 'rectification')
    expect(describeEvent(head, after, ctxFor()).text).toBe('Going back: Illegal substitution · VC Smash (A) · 4 point(s) of A cancelled, point to B · Set 2 · A 1:4 B')
    const cp = after.find(e => e.type === 'cancelled_point')
    expect(describeEvent(cp, after, ctxFor()).title).toBe('Point cancelled: VC Smash')
  })

  it('refuses a finished set and another set than the one being played', () => {
    const { events } = build()
    const moment = { kind: 'score', boundarySeq: -Infinity, score: { home: 0, away: 0 } }
    expect(planRectification(events, { kind: 'lineup_discrepancy', setIndex: 1, team: 'home', moment }, { ...ctxFor(), liveSetIndex: 1 }).error).toBe('rectify.error.setFinished')
    expect(planRectification(events, { kind: 'lineup_discrepancy', setIndex: 1, team: 'home', moment }, ctxFor()).error).toBe('rectify.error.notLive')
  })
})

describe('rectify: positions not as on the line-up sheet (R7.3.5.3; SSK 5:7 -> 0:8)', () => {
  it('a wrong player since 0:0 found at 5:7: play goes on at 0:8', () => {
    // set 2: home 5, away 7, away scored last
    const { events } = liveMatch('HAHAHAHAHAAA')
    expect(score(events)).toBe('5:7')
    const moments = rectifyMoments(events, { kind: 'lineup_discrepancy', setIndex: 2, team: 'home' }, ctxFor())
    const start = moments.find(m => m.label.startsWith('Start of the set'))
    expect(start).toBeTruthy()
    const plan = planRectification(events, { kind: 'lineup_discrepancy', setIndex: 2, team: 'home', moment: start }, ctxFor())
    const after = applyPlanToEvents(events, plan)
    expect(score(after)).toBe('0:8')
    // away was serving: no rotation for the penalty point
    const penalty = after.find(e => e.type === 'point' && e.payload?.rectification)
    expect(after.some(e => e.type === 'lineup' && Math.floor(e.seq) === penalty.seq)).toBe(false)
    expect(plan.preview.server).toBe('away')
  })

  it('from a later score only the later points of the team go', () => {
    const { events } = liveMatch('HAHAHAHAHAAA')
    const at33 = rectifyMoments(events, { kind: 'lineup_discrepancy', setIndex: 2, team: 'home' }, ctxFor()).find(m => m.score.home === 3 && m.score.away === 3)
    const plan = planRectification(events, { kind: 'lineup_discrepancy', setIndex: 2, team: 'home', moment: at33 }, ctxFor())
    expect(score(applyPlanToEvents(events, plan))).toBe('3:8')
  })
})

describe('rectify: wrong server found later (R7.7.1, 7.7.2, CB 2.5)', () => {
  // set 2, away serves first: A A H H H -> home gains the serve at 1:2 and
  // serves from there (#2, rotated into I): 3:2
  it('offers the service turns of the team with the server\'s number', () => {
    const { events } = liveMatch('AAHHH')
    const moments = rectifyMoments(events, { kind: 'rotation_fault', setIndex: 2, team: 'home' }, ctxFor())
    expect(moments.map(m => m.kind)).toEqual(['service', 'unknown'])
    expect(moments[0].label).toBe('Service of #2 at A 1:2 B')
    const { rallies } = servedRallies(events, 2, LIVE)
    expect(rallies.map(r => r.server)).toEqual(['away', 'away', 'away', 'home', 'home'])
  })

  it('found later: the points since the wrong service are cancelled, point and service to the opponent', () => {
    const { events } = liveMatch('AAHHH')
    const turn = rectifyMoments(events, { kind: 'rotation_fault', setIndex: 2, team: 'home' }, ctxFor())[0]
    const plan = planRectification(events, { kind: 'rotation_fault', setIndex: 2, team: 'home', moment: turn }, ctxFor())
    // the side-out point that gave home the serve stays (home did not serve it)
    expect(score(applyPlanToEvents(events, plan))).toBe('1:3')
  })

  it('found right after the rally of the wrong service, which the opponent won: the one single point, nothing added (7.7.1.1)', () => {
    // home gains the serve at 1:2, its server serves wrongly and loses: 1:3
    const { events } = liveMatch('AAHA')
    const turn = rectifyMoments(events, { kind: 'rotation_fault', setIndex: 2, team: 'home' }, ctxFor())[0]
    expect(turn.score).toEqual({ home: 1, away: 2 })
    const plain = planRectification(events, { kind: 'rotation_fault', setIndex: 2, team: 'home', moment: turn }, ctxFor())
    expect(plain.error).toBe('rectify.error.nothingToChange')
    // with the order put right in the app it is recorded, without a point
    const lineup = { ...lastLineup(events, 'home') }
    const [a, b] = [lineup.I, lineup.II]
    lineup.I = b
    lineup.II = a
    const plan = planRectification(events, { kind: 'rotation_fault', setIndex: 2, team: 'home', moment: turn, lineup }, ctxFor())
    expect(plan.error).toBeUndefined()
    expect(plan.notes.map(n => n.key)).toContain('rectify.note.singlePoint')
    expect(score(applyPlanToEvents(events, plan))).toBe('1:3')
    expect(plan.preview.lineupChanged).toBe(true)
  })

  it('found right after the rally of the wrong service, which the team at fault won: that point goes to the opponent', () => {
    const { events } = liveMatch('AAHH')
    const turn = rectifyMoments(events, { kind: 'rotation_fault', setIndex: 2, team: 'home' }, ctxFor())[0]
    const plan = planRectification(events, { kind: 'rotation_fault', setIndex: 2, team: 'home', moment: turn }, ctxFor())
    expect(score(applyPlanToEvents(events, plan))).toBe('1:3')
  })

  it('moment not known: only point and service to the opponent (7.7.2)', () => {
    const { events } = liveMatch('AAHHH')
    const unknown = rectifyMoments(events, { kind: 'rotation_fault', setIndex: 2, team: 'home' }, ctxFor()).find(m => m.kind === 'unknown')
    const plan = planRectification(events, { kind: 'rotation_fault', setIndex: 2, team: 'home', moment: unknown }, ctxFor())
    expect(score(applyPlanToEvents(events, plan))).toBe('3:3')
    expect(plan.notes.map(n => n.key)).toContain('rectify.note.momentUnknown')
    expect(plan.remarkAdd[0]).toMatch(/moment not known; point and service to team B; score now 3:3\.$/)
  })
})

describe('rectify: illegal libero replacement found after the service (R19.3.2.9, CB 5.7)', () => {
  it('offers the libero replacements and cancels the points since', () => {
    // away serves first; at 0:1 home libero #9 in for #5 (back row V)
    const { events } = liveMatch('AHHA', [{ at: 1, type: 'libero_entry', payload: { team: 'home', playerOut: 5, liberoIn: 9 } }])
    const moments = rectifyMoments(events, { kind: 'illegal_libero', setIndex: 2, team: 'home' }, ctxFor())
    expect(moments).toHaveLength(1)
    const plan = planRectification(events, { kind: 'illegal_libero', setIndex: 2, team: 'home', moment: moments[0] }, ctxFor())
    expect(score(applyPlanToEvents(events, plan))).toBe('0:3')
  })
})

describe('rectify: back to an earlier score, officials\' mistake (CB 2.3, 2.4)', () => {
  const build = () => liveMatch('HHAAHA', [
    { at: 3, type: 'timeout', payload: { team: 'away' } },
    { at: 4, type: 'sanction', payload: { team: 'away', type: 'warning', playerType: 'player', playerNumber: 12 } }
  ])

  it('takes the rallies since that score out for both teams; time-outs and sanctions stay; no penalty point', () => {
    const { events } = build()
    expect(score(events)).toBe('3:3')
    const moments = rectifyMoments(events, { kind: 'official_error', setIndex: 2 }, ctxFor())
    // every score of the set but the current one
    expect(moments.map(m => `${m.score.home}:${m.score.away}`)).toEqual(['3:2', '2:2', '2:1', '2:0', '1:0', '0:0'])
    const at20 = moments.find(m => m.score.home === 2 && m.score.away === 0)
    const plan = planRectification(events, { kind: 'official_error', setIndex: 2, moment: at20 }, ctxFor())
    expect(plan.error).toBeUndefined()
    const after = applyPlanToEvents(events, plan)
    expect(score(after)).toBe('2:0')
    expect(after.some(e => e.type === 'timeout' && e.setIndex === 2)).toBe(true)
    expect(after.some(e => e.type === 'sanction' && e.setIndex === 2)).toBe(true)
    expect(plan.preview.penalty).toBe(false)
    expect(plan.preview.server).toBe('home')
    // the rotations go back with the rallies: away's line-up as at 2:0
    expect(lastLineup(after, 'away')).toEqual(lastLineup(events.filter(e => (e.seq || 0) <= at20.boundarySeq), 'away'))
    expect(plan.notes.map(n => n.key)).toEqual(expect.arrayContaining(['rectify.note.timeline', 'rectify.note.sanctionsStay']))
    expect(plan.remarkAdd[0]).toBe('Set 2, Result 3:3: officials\' mistake (Casebook 2.3); score taken back to 2:0, sanctions remain valid.')
  })

  it('is taken back while it is the newest entry: the rallies come back', () => {
    const { events } = build()
    const at20 = rectifyMoments(events, { kind: 'official_error', setIndex: 2 }, ctxFor()).find(m => m.score.home === 2 && m.score.away === 0)
    const plan = planRectification(events, { kind: 'official_error', setIndex: 2, moment: at20 }, ctxFor())
    const after = applyPlanToEvents(events, plan).map((e, i) => (typeof e.id === 'string' ? { ...e, id: 9000 + i } : e))
    const head = after.find(e => e.type === 'rectification')
    const back = planRectificationReversal(after, head.id, ctxFor())
    expect(back.error).toBeUndefined()
    const restored = applyPlanToEvents(after, back)
    expect(score(restored)).toBe('3:3')
    expect(lastLineup(restored, 'away')).toEqual(lastLineup(events, 'away'))
    // a rally played after it: refused
    const later = [...after, { id: 9999, matchId: 1, setIndex: 2, type: 'point', seq: head.seq + 1, ts: head.ts, payload: { team: 'home' } }]
    expect(planRectificationReversal(later, head.id, ctxFor()).error).toBe('rectify.error.notLast')
  })

  it('one going back at a time: moments before it are not offered, the newest is taken back first', () => {
    const { events } = build()
    const at22 = rectifyMoments(events, { kind: 'official_error', setIndex: 2 }, ctxFor()).find(m => m.score.home === 2 && m.score.away === 2)
    const first = planRectification(events, { kind: 'official_error', setIndex: 2, moment: at22 }, ctxFor())
    const after = applyPlanToEvents(events, first).map((e, i) => (typeof e.id === 'string' ? { ...e, id: 9000 + i } : e))
    const moments = rectifyMoments(after, { kind: 'lineup_discrepancy', setIndex: 2, team: 'home' }, ctxFor())
    expect(moments.map(m => `${m.score.home}:${m.score.away}`)).toEqual(['2:2'])
  })
})

describe('rectify: illegal entry noticed before the next service (R16.1.3, 19.3.2.9)', () => {
  it('takes the substitution back and gives a delay warning; a second time a delay penalty with its point', () => {
    const { events } = liveMatch('HA', [{ at: 2, type: 'substitution', payload: { team: 'home', playerOut: 4, playerIn: 7 } }])
    const [sub] = entriesBeforeService(events, { setIndex: 2, team: 'home' })
    expect(sub.type).toBe('substitution')
    const plan = planIllegalEntryBeforeService(events, { setIndex: 2, team: 'home', eventId: sub.id }, ctxFor())
    expect(plan.error).toBeUndefined()
    const after = applyPlanToEvents(events, plan)
    expect(after.some(e => e.type === 'substitution' && e.setIndex === 2)).toBe(false)
    expect(after.find(e => e.type === 'sanction').payload).toMatchObject({ team: 'home', type: 'delay_warning' })
    expect(plan.followUp).toBeNull()
    expect(plan.log.text).toMatch(/^Taken back before the service: Substitution/)

    // already warned for delay: a delay penalty, the point follows
    const warned = [...events, { id: 777, matchId: 1, setIndex: 2, type: 'sanction', seq: 1, ts: events[0].ts, payload: { team: 'home', type: 'delay_warning' } }]
    const second = planIllegalEntryBeforeService(warned, { setIndex: 2, team: 'home', eventId: sub.id }, ctxFor())
    expect(second.rectification.sanctionType).toBe('delay_penalty')
    expect(second.followUp).toEqual({ awardPointTo: 'away' })
    expect(second.rectification.penaltySeq).toBe(second.add.find(r => r.type === 'sanction').seq)
  })

  it('refuses an entry a rally has followed', () => {
    const { events } = liveMatch('HAH', [{ at: 2, type: 'substitution', payload: { team: 'home', playerOut: 4, playerIn: 7 } }])
    const sub = events.find(e => e.type === 'substitution')
    expect(entriesBeforeService(events, { setIndex: 2, team: 'home' })).toEqual([])
    expect(planIllegalEntryBeforeService(events, { setIndex: 2, team: 'home', eventId: sub.id }, ctxFor()).error).toBe('rectify.error.notBeforeService')
  })
})

describe('rectify: the rebuild of a log with cancelled points', () => {
  it('finalizing an empty plan on it changes nothing', () => {
    const { events } = liveMatch('HHAAHH')
    const moment = rectifyMoments(events, { kind: 'lineup_discrepancy', setIndex: 2, team: 'home' }, ctxFor()).find(m => m.score.home === 2 && m.score.away === 2)
    const plan = planRectification(events, { kind: 'lineup_discrepancy', setIndex: 2, team: 'home', moment }, ctxFor())
    const after = applyPlanToEvents(events, plan)
    const again = finalizePlan(after, { add: [], update: [], remove: [], affectedSets: [] }, ctxFor())
    expect(again.add).toEqual([])
    expect(again.update).toEqual([])
    expect(again.remove).toEqual([])
    expect(again.affectedSets).toEqual([])
  })
})
