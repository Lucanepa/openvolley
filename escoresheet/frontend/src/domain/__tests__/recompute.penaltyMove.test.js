// A penalty moved or changed with the sanction form, and the point it gave
// (audit LOG-16). The form removes the sanction and adds it again where the
// scorer chose. Moved to another set, the rebuild rewrote the point's link
// (payload.penaltySeq) to the sanction's seq in the OTHER set: the point
// stayed in its set as a plain point naming nothing, the new set circled
// another point, and the scorer was not told. Now a penalty whose point is
// on record is not moved to another set (removed first, the scorer decides
// about that point); a penalty made a sanction that gives no point, or
// given to the other team, leaves its point as a rally point (link dropped,
// "the point stays" shown); a move within the set keeps the link.
import { describe, it, expect } from 'vitest'
import { planMoveEvent, planEditEvent, applyPlanToEvents, errorText, scoreTimeline } from '../manualCorrections'
import { finalizePlan, matchIssues } from '../recompute'
import { penaltyOfPoint } from '../sanctions'
import { scoreFromPointEvents } from '../rules'
import { buildMatch, MATCH, HOME_TEAM, AWAY_TEAM } from './fixtures/correctionsMatch'

const LIVE = { ...MATCH, status: 'live' }
const ctx = { match: LIVE, homeTeam: HOME_TEAM, awayTeam: AWAY_TEAM, matchId: 1, mode: 'live', liveSetIndex: 2 }
const keys = (list) => (list || []).map(i => i.key)
const PENALTY_ISSUES = ['corrections.issue.penaltyWithoutPoint', 'corrections.issue.penaltyLinkBroken']

// set 1 25:5 (finished), set 2 live: H A H A H | a penalty of away | H (its point, 4:2)
function fixture({ type = 'delay_penalty', linked = true, points = 'HAHAHH' } = {}) {
  const payload = type === 'penalty'
    ? { team: 'away', type, playerType: 'player', playerNumber: 12 }
    : { team: 'away', type }
  const m = buildMatch({
    match: LIVE,
    sets: [
      { points: 'HHHHHAAAAA' + 'H'.repeat(20), finished: true },
      { points, finished: false, extras: [{ at: 5, type: 'sanction', payload }] }
    ]
  })
  const sanction = m.events.find(e => e.type === 'sanction')
  const pp = m.events.filter(e => e.type === 'point' && e.setIndex === 2 && e.seq > sanction.seq)[0]
  if (linked) pp.payload = { ...pp.payload, penaltySeq: sanction.seq }
  const ownStart = m.events.filter(e => e.type === 'rally_start' && e.setIndex === 2 && e.seq < pp.seq && e.seq > sanction.seq)
  return { ...m, events: m.events.filter(e => !ownStart.includes(e)), sanction, pp }
}

describe('a penalty moved to another set', () => {
  it('is refused while its point is on record, saying where that point is', () => {
    const { events, sanction } = fixture()
    const plan = planMoveEvent(events, sanction.id, { setIndex: 1, at: 15 }, ctx)
    expect(plan.error).toBe('corrections.error.penaltyOtherSet')
    expect(plan.params.set).toBe(2)
    expect(errorText(plan, null)).toMatch(/^The point this sanction gave is in set 2 \(.*4:2.*\)\./)
  })

  it('the sanction form with another set: the same', () => {
    const { events, sanction } = fixture({ type: 'penalty' })
    const plan = planEditEvent(events, sanction.id, { setIndex: 1, at: 15, type: 'penalty', target: { playerType: 'player', playerNumber: 12 } }, ctx)
    expect(plan.error).toBe('corrections.error.penaltyOtherSet')
  })

  it('a penalty written before the link (no point names it) still moves, as before', () => {
    const { events, sanction } = fixture({ linked: false })
    const plan = planMoveEvent(events, sanction.id, { setIndex: 1, at: 15 }, ctx)
    expect(plan.error).toBeUndefined()
    const after = applyPlanToEvents(events, plan)
    expect(after.find(e => e.id === sanction.id).setIndex).toBe(1)
  })

  it('the rebuild never leaves a link to a sanction of another set (a plan that moved it anyway)', () => {
    const { events, sanction, pp } = fixture()
    const plan = { add: [], update: [{ id: sanction.id, changes: { setIndex: 1, seq: 3 } }], remove: [], affectedSets: [], setUpdates: [], remarkAdd: [], remarkRemove: [], notes: [], followUp: null }
    const done = finalizePlan(events, plan, ctx)
    const after = applyPlanToEvents(events, done)
    const point = after.find(e => e.id === pp.id)
    expect(point.setIndex).toBe(2)
    expect(point.payload.penaltySeq).toBeUndefined()
    expect(keys(matchIssues(after, ctx))).not.toContain('corrections.issue.penaltyLinkBroken')
  })
})

describe('a penalty moved within its set', () => {
  it('to an earlier score: its point keeps naming it (the link follows the new seq)', () => {
    const { events, sanction, pp } = fixture()
    const at = scoreTimeline(events, 2).findIndex(x => x.home === 2 && x.away === 1)
    const plan = planMoveEvent(events, sanction.id, { setIndex: 2, at }, ctx)
    expect(plan.error).toBeUndefined()
    const after = applyPlanToEvents(events, plan)
    const point = after.find(e => e.id === pp.id)
    expect(penaltyOfPoint(after, point)?.id).toBe(sanction.id)
    expect(point.payload.penaltySeq).toBe(after.find(e => e.id === sanction.id).seq)
    expect(keys(plan.newIssues).filter(k => PENALTY_ISSUES.includes(k))).toEqual([])
  })
})

describe('a penalty changed so that it no longer gives the point', () => {
  // the form keeps the score it was given at (3:2)
  const at32 = (events) => scoreTimeline(events, 2).findIndex(x => x.home === 3 && x.away === 2)
  it('made a warning: its point stays a rally point, the link goes, and the form says so', () => {
    const { events, sanction, pp } = fixture({ type: 'penalty' })
    const plan = planEditEvent(events, sanction.id, { at: at32(events), type: 'warning', target: { playerType: 'player', playerNumber: 12 } }, ctx)
    expect(plan.error).toBeUndefined()
    expect(keys(plan.notes)).toContain('corrections.note.pointStays')
    const after = applyPlanToEvents(events, plan)
    const point = after.find(e => e.id === pp.id)
    expect(point.payload.penaltySeq).toBeUndefined()
    expect(scoreFromPointEvents(after, 2)).toEqual({ homePoints: 4, awayPoints: 2 })
    expect(keys(matchIssues(after, ctx)).filter(k => PENALTY_ISSUES.includes(k))).toEqual([])
  })

  it('given to the other team: the same (home\'s point is no penalty of home\'s)', () => {
    // away scores later (4:3): the point home's delay penalty circles
    const { events, sanction, pp } = fixture({ points: 'HAHAHHA' })
    const plan = planEditEvent(events, sanction.id, { at: at32(events), team: 'home', type: 'delay_penalty' }, ctx)
    expect(plan.error).toBeUndefined()
    expect(keys(plan.notes)).toContain('corrections.note.pointStays')
    const after = applyPlanToEvents(events, plan)
    expect(after.find(e => e.id === pp.id).payload.penaltySeq).toBeUndefined()
    expect(keys(matchIssues(after, ctx))).not.toContain('corrections.issue.penaltyLinkBroken')
  })

  it('a penalty kept a penalty (another player): the link and its point stay, no note', () => {
    const { events, sanction, pp } = fixture({ type: 'penalty' })
    const plan = planEditEvent(events, sanction.id, { at: at32(events), type: 'penalty', target: { playerType: 'player', playerNumber: 13 } }, ctx)
    expect(plan.error).toBeUndefined()
    expect(keys(plan.notes)).not.toContain('corrections.note.pointStays')
    const after = applyPlanToEvents(events, plan)
    expect(penaltyOfPoint(after, after.find(e => e.id === pp.id))?.id).toBe(sanction.id)
  })
})
