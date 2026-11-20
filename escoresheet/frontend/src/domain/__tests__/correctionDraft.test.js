import { describe, it, expect } from 'vitest'
import {
  planAddPoint, planRemovePoint, planLastPointOtherTeam, planAddTimeout, planRotateTeam, scoreTimeline, courtAt
} from '../manualCorrections'
import { baseDraft, buildDraft, combinedPlan, newIssues, stepLines } from '../correctionDraft'
import { planSwitchSides } from '../../components/corrections/liveActions'
import { scoreFromPointEvents, getLeftTeamLabelForSet } from '../rules'
import { compareBySeq } from '../describe'
import { buildMatch, MATCH, HOME_TEAM, AWAY_TEAM, pointsFor } from './fixtures/correctionsMatch'

// Set 1 25:20 (finished), set 2 being played at 12:10
function fixture() {
  return buildMatch({
    sets: [
      { points: pointsFor(25, 20), finished: true },
      { points: pointsFor(12, 10).slice(0, 22), finished: false }
    ]
  })
}

const SETS = [{ id: 1, index: 1, finished: true, homePoints: 25, awayPoints: 20 }, { id: 2, index: 2, finished: false, homePoints: 12, awayPoints: 10 }]
const ctxOf = (match = MATCH) => ({ match, homeTeam: HOME_TEAM, awayTeam: AWAY_TEAM, matchId: 1, mode: 'live', liveSetIndex: 2 })
const lastPoint = (events, setIndex) => events.filter(e => e.type === 'point' && e.setIndex === setIndex).sort(compareBySeq).pop()
const serverAfter = (events, setIndex) => lastPoint(events, setIndex)?.payload?.team

describe('planAddPoint (board "+", set being played)', () => {
  it('adds the point at the current score, with the side-out rotation when the receiving team scores', () => {
    const { events } = fixture()
    const server = serverAfter(events, 2)
    const receiver = server === 'home' ? 'away' : 'home'
    const before = courtAt(events, 2, receiver, scoreTimeline(events, 2).length - 1).lineup
    const plan = planAddPoint(events, SETS, { setIndex: 2, team: receiver }, ctxOf())
    expect(plan.error).toBeUndefined()
    const draft = buildDraft(baseDraft({ events, match: MATCH, sets: SETS }), [{ plan }])
    const sc = scoreFromPointEvents(draft.events, 2)
    expect(sc[receiver === 'home' ? 'homePoints' : 'awayPoints']).toBe(receiver === 'home' ? 13 : 11)
    const after = courtAt(draft.events, 2, receiver, scoreTimeline(draft.events, 2).length - 1).lineup
    expect(after.I).toBe(before.II) // rotated one position
    expect(lastPoint(draft.events, 2).payload.score).toEqual(receiver === 'home' ? { home: 13, away: 10 } : { home: 12, away: 11 })
    // the set row follows the points
    expect(draft.sets.find(s => s.index === 2)).toMatchObject(sc)
  })

  it('a point of the serving team rotates nobody', () => {
    const { events } = fixture()
    const server = serverAfter(events, 2)
    const plan = planAddPoint(events, SETS, { setIndex: 2, team: server }, ctxOf())
    expect(plan.error).toBeUndefined()
    expect(plan.add.filter(r => r.type === 'lineup')).toHaveLength(0)
  })

  it('refuses the point that would end the set (the point button runs the set end)', () => {
    const { events } = buildMatch({ sets: [{ points: pointsFor(24, 20).slice(0, 44), finished: false }] })
    const sets = [{ id: 1, index: 1, finished: false }]
    const plan = planAddPoint(events, sets, { setIndex: 1, team: 'home' }, { ...ctxOf(), liveSetIndex: 1 })
    expect(plan.error).toBe('corrections.error.pointEndsSet')
  })

  it('a finished set follows the final score rule', () => {
    const { events } = fixture()
    const plan = planAddPoint(events, SETS, { setIndex: 1, team: 'home' }, ctxOf())
    // 26:20 is not a possible final score
    expect(plan.error).toBe('corrections.error.invalidFinalScore')
    const ok = planAddPoint(events, SETS, { setIndex: 1, team: 'away' }, ctxOf())
    expect(ok.error).toBeUndefined()
  })
})

describe('planRemovePoint (board "−") and planLastPointOtherTeam', () => {
  it('removes the team\'s latest point of the set being played, even when the other team scored after it', () => {
    const { events } = fixture()
    const last = lastPoint(events, 2)
    const other = last.payload.team === 'home' ? 'away' : 'home'
    const plan = planRemovePoint(events, SETS, { setIndex: 2, team: other }, ctxOf())
    expect(plan.error).toBeUndefined()
    const draft = buildDraft(baseDraft({ events, match: MATCH, sets: SETS }), [{ plan }])
    const sc = scoreFromPointEvents(draft.events, 2)
    expect(sc.homePoints + sc.awayPoints).toBe(21)
  })

  it('gives the last point to the other team', () => {
    const { events } = fixture()
    const last = lastPoint(events, 2)
    const plan = planLastPointOtherTeam(events, { setIndex: 2 }, ctxOf())
    expect(plan.error).toBeUndefined()
    const draft = buildDraft(baseDraft({ events, match: MATCH, sets: SETS }), [{ plan }])
    expect(lastPoint(draft.events, 2).payload.team).not.toBe(last.payload.team)
  })
})

describe('the draft chains plans (planned on the draft before them) and writes them as one', () => {
  it('a point, a time-out at the new score and a rotation: the draft and the combined plan agree', () => {
    const { events } = fixture()
    const base = baseDraft({ events, match: MATCH, sets: SETS })
    const ctx = ctxOf()
    const steps = []
    const stage = (planner) => {
      const draft = buildDraft(base, steps)
      const plan = planner(draft, { ...ctx, match: draft.match })
      expect(plan.error).toBeUndefined()
      steps.push({ plan })
    }
    stage((d, c) => planAddPoint(d.events, d.sets, { setIndex: 2, team: 'away' }, c))
    stage((d, c) => planAddTimeout(d.events, { setIndex: 2, team: 'home', at: scoreTimeline(d.events, 2).length - 1 }, c))
    stage((d, c) => planRotateTeam(d.events, { setIndex: 2, team: 'home', direction: 1 }, c))
    const draft = buildDraft(base, steps)
    const plan = combinedPlan(base, steps)
    expect(plan.logs).toHaveLength(3)
    expect(stepLines(steps).map(l => l.text)).toEqual(plan.logs.map(l => l.text))
    // what applyCorrectionPlan writes, the draft shows: events after the combined plan
    const written = buildDraft(base, [{ plan }])
    const strip = (list) => list.map(({ id, tempKey, ...rest }) => rest).sort(compareBySeq)
    expect(strip(written.events)).toEqual(strip(draft.events))
    // the time-out sits at the score the added point made
    const to = draft.events.find(e => e.type === 'timeout' && e.setIndex === 2)
    expect(to).toBeTruthy()
    expect(newIssues(base, draft, ctx)).toEqual([])
  })

  it('switch sides is a match-row patch; staging it twice cancels out', () => {
    const { events } = fixture()
    const base = baseDraft({ events, match: MATCH, sets: SETS })
    const one = planSwitchSides(base.match, 2, {})
    const d1 = buildDraft(base, [{ plan: one }])
    expect(getLeftTeamLabelForSet(2, d1.match)).not.toBe(getLeftTeamLabelForSet(2, MATCH))
    const two = planSwitchSides(d1.match, 2, {})
    const steps = [{ plan: one }, { plan: two }]
    expect(getLeftTeamLabelForSet(2, buildDraft(base, steps).match)).toBe(getLeftTeamLabelForSet(2, MATCH))
    const plan = combinedPlan(base, steps)
    expect(plan.logs).toHaveLength(2)
    // the sides of every set end as they were, so nothing else is patched
    expect(Object.keys(plan.matchPatch || {}).every(k => k === 'setLeftTeamOverrides')).toBe(true)
  })

  it('remarks: the combined plan carries the final text', () => {
    const { events } = fixture()
    const base = baseDraft({ events, match: { ...MATCH, remarks: 'one' }, sets: SETS })
    const a = { plan: { ...combinedPlan(base, []), remarkAdd: ['two'], log: { action: 'addRemark', text: 'Remark added' } } }
    const b = { plan: { ...combinedPlan(base, []), remarksSet: 'one\ntwo edited', log: { action: 'editRemark', text: 'Remark changed' } } }
    const plan = combinedPlan(base, [a, b])
    expect(plan.remarksSet).toBe('one\ntwo edited')
    expect(plan.remarkAdd).toEqual([])
  })
})
