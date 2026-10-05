import { describe, it, expect } from 'vitest'
import { decisionChangeUndoRecord, planDecisionChangeReversal, syncJobsForEvents } from '../corrections'

// Set 1 at 3-2 (home), then point 6 goes to AWAY by mistake: away (receiving)
// sides out, so the point wrote away's rotation 6.1 and an auto libero_exit 6.2.
// The decision change gives it to HOME (serving -> no rotation for home).
const point = (id, seq, team, setIndex = 1) => ({ id, seq, setIndex, type: 'point', payload: { team } })

function scenario({ newTeamRotates = false } = {}) {
  const before = [
    point(1, 1, 'home'), point(2, 2, 'home'), point(3, 3, 'away'), point(4, 4, 'home'), point(5, 5, 'away'),
    point(6, 6, 'away'),
    { id: 61, seq: 6.1, setIndex: 1, type: 'lineup', payload: { team: 'away', lineup: { I: '2' }, liberoSubstitution: { liberoNumber: 9, playerNumber: 5, position: 'V' } } },
    { id: 62, seq: 6.2, setIndex: 1, type: 'libero_exit', payload: { team: 'away', liberoOut: 9, playerIn: 5 } }
  ]
  const pointBefore = before.find(e => e.id === 6)
  const removed = before.filter(e => e.id === 61 || e.id === 62)

  // After the swap: point 6 is home's, away's sub-events are gone, home's
  // rotation (when home was receiving) is a new sub-event 6.3
  const created = newTeamRotates
    ? [{ id: 63, seq: 6.3, setIndex: 1, type: 'lineup', payload: { team: 'home', lineup: { I: '7' }, fromDecisionChange: true } }]
    : []
  const decision = {
    id: 7, seq: 7, setIndex: 1, type: 'decision_change',
    payload: {
      reason: 'point_swap', fromTeam: 'away', toTeam: 'home',
      ...decisionChangeUndoRecord(pointBefore, removed, created.map(e => e.id))
    }
  }
  const after = before
    .filter(e => e.id !== 61 && e.id !== 62)
    .map(e => (e.id === 6 ? { ...e, payload: { team: 'home', swappedFrom: 'away' } } : e))
    .concat(created, [decision])
  return { after, decision }
}

describe('decisionChangeUndoRecord', () => {
  it('copies the point payload and the removed rows, so later edits do not leak in', () => {
    const p = point(6, 6, 'away')
    const rec = decisionChangeUndoRecord(p, [{ id: 61 }], [63])
    p.payload.team = 'home'
    expect(rec).toEqual({ pointEventId: 6, pointPayloadBefore: { team: 'away' }, removedSubEvents: [{ id: 61 }], createdSubEventIds: [63] })
  })
})

describe('planDecisionChangeReversal', () => {
  it('puts the point back, restores the old team sub-events and removes the new ones', () => {
    const { after, decision } = scenario({ newTeamRotates: true })
    const plan = planDecisionChangeReversal(decision, after)
    expect(plan.pointEventId).toBe(6)
    expect(plan.pointPayload).toEqual({ team: 'away' })
    expect(plan.deleteEventIds).toEqual([7, 63])
    expect(plan.restoreEvents.map(e => e.id)).toEqual([61, 62])
    expect(plan.restoreEvents[0].payload.liberoSubstitution).toBeTruthy()
    expect(plan.setIndex).toBe(1)
  })

  it('recounts the set score from the point events (3-3 after the undo, not the snapshot)', () => {
    const { after, decision } = scenario()
    const plan = planDecisionChangeReversal(decision, after)
    // home: 1,2,4 = 3 ; away: 3,5,6 = 3
    expect(plan.score).toEqual({ homePoints: 3, awayPoints: 3 })
    expect(plan.deleteEventIds).toEqual([7])
  })

  it('does not re-add a row that still exists or delete a created row already gone', () => {
    const { after, decision } = scenario({ newTeamRotates: true })
    const withOld = after.filter(e => e.id !== 63).concat([{ id: 61, seq: 6.1, setIndex: 1, type: 'lineup', payload: { team: 'away' } }])
    const plan = planDecisionChangeReversal(decision, withOld)
    expect(plan.deleteEventIds).toEqual([7])
    expect(plan.restoreEvents.map(e => e.id)).toEqual([62])
  })

  it('returns null for a decision change without undo record or whose point is gone', () => {
    expect(planDecisionChangeReversal({ id: 7, type: 'decision_change', payload: { fromTeam: 'away', toTeam: 'home' } }, [])).toBeNull()
    const { after, decision } = scenario()
    expect(planDecisionChangeReversal(decision, after.filter(e => e.id !== 6))).toBeNull()
  })
})

describe('syncJobsForEvents', () => {
  it('matches queued event jobs by external_id, never a set job with the same id', () => {
    const jobs = [
      { id: 1, resource: 'event', payload: { external_id: '61' } },
      { id: 2, resource: 'set', payload: { external_id: '61' } },
      { id: 3, resource: 'event', payload: { external_id: '99' } },
      { id: 4, resource: 'match', payload: { id: 'abc' } }
    ]
    expect(syncJobsForEvents(jobs, [61, 62]).map(j => j.id)).toEqual([1])
    expect(syncJobsForEvents(jobs, [])).toEqual([])
  })
})
