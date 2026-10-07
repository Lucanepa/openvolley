import { describe, it, expect } from 'vitest'
import { decisionChangeUndoRecord, planDecisionChangeReversal, planPointRemoval, syncJobsForEvents, syncJobsForSets, localIdOfExtId, setScoreSyncJobs } from '../corrections'

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

  it('matches the namespaced ids every job carries now (<seed>:e:<id>)', () => {
    const jobs = [
      { id: 1, resource: 'event', payload: { external_id: 'match_100_aaa:e:61' } },
      { id: 2, resource: 'event', payload: { external_id: 'match_100_aaa:e:610' } },
      { id: 3, resource: 'set', payload: { external_id: 'match_100_aaa:s:62' } },
      { id: 4, resource: 'event', payload: { external_id: 'match_100_aaa:s:62' } },
      { id: 5, resource: 'event', payload: { external_id: 'match_100_aaa:e:62' } },
      { id: 6, resource: 'event', payload: { external_id: 'coin_toss_match_100_aaa' } }
    ]
    expect(syncJobsForEvents(jobs, [61, 62]).map(j => j.id)).toEqual([1, 5])
  })
})

describe('syncJobsForSets', () => {
  it('matches set jobs by namespaced or bare local id', () => {
    const jobs = [
      { id: 1, resource: 'set', payload: { external_id: 'match_100_aaa:s:7' } },
      { id: 2, resource: 'set', payload: { external_id: '7' } },
      { id: 3, resource: 'event', payload: { external_id: 'match_100_aaa:e:7' } },
      { id: 4, resource: 'set', payload: { external_id: 'match_100_aaa:s:8' } }
    ]
    expect(syncJobsForSets(jobs, [7]).map(j => j.id)).toEqual([1, 2])
    expect(localIdOfExtId('match_1_a:e:3', 'set')).toBeNull()
    expect(localIdOfExtId(null, 'event')).toBeNull()
  })
})

describe('setScoreSyncJobs (Manual adjustments sends corrected sets; review fix)', () => {
  it('one set update per changed set, keyed like the scoreboard', () => {
    const jobs = setScoreSyncJobs('match_1', [{ id: 12, homePoints: 25, awayPoints: 22, finished: true }, { id: 13, homePoints: '7', awayPoints: null, finished: false }], 'T')
    expect(jobs).toEqual([
      { resource: 'set', action: 'update', payload: { external_id: 'match_1:s:12', home_points: 25, away_points: 22, finished: true }, ts: 'T', status: 'queued' },
      { resource: 'set', action: 'update', payload: { external_id: 'match_1:s:13', home_points: 7, away_points: 0, finished: false }, ts: 'T', status: 'queued' }
    ])
    expect(setScoreSyncJobs(null, [{ id: 1 }])).toEqual([])
    expect(setScoreSyncJobs('m', [{ homePoints: 1 }])).toEqual([])
  })
})

describe('planPointRemoval (taking back a point recorded in error)', () => {
  // Set 5 at 7:7. Away scores the 8th point on a side-out: the point (seq 20)
  // wrote away's rotation (20.1) and an auto libero_exit (20.2). Earlier,
  // home's point 18 rotated (18.1) and a substitution (19 + 19.1) followed.
  const events = [
    { id: 17, seq: 17, setIndex: 5, type: 'rally_start', payload: {} },
    point(18, 18, 'home', 5),
    { id: 181, seq: 18.1, setIndex: 5, type: 'lineup', payload: { team: 'home', lineup: { I: '3' } } },
    { id: 19, seq: 19, setIndex: 5, type: 'substitution', payload: { team: 'home', playerOut: 3, playerIn: 13 } },
    { id: 191, seq: 19.1, setIndex: 5, type: 'lineup', payload: { team: 'home', lineup: { I: '13' }, fromSubstitution: true } },
    { id: 195, seq: 19.5, setIndex: 5, type: 'rally_start', payload: {} },
    point(20, 20, 'away', 5),
    { id: 201, seq: 20.1, setIndex: 5, type: 'lineup', payload: { team: 'away', lineup: { I: '4' } } },
    { id: 202, seq: 20.2, setIndex: 5, type: 'libero_exit', payload: { team: 'away', liberoOut: 9, playerIn: 5 } },
    point(4, 4, 'home', 1)
  ]
  const pointEvent = events.find(e => e.id === 20)

  it('removes the point with every sub-event it wrote (rotation, libero exit), not only the newest row', () => {
    const plan = planPointRemoval(events, pointEvent)
    expect(plan.deleteEventIds.sort()).toEqual([20, 201, 202])
    expect(plan.setIndex).toBe(5)
  })

  it('the set score follows the remaining point events', () => {
    // set 5 has one home and one away point; the away point goes
    expect(planPointRemoval(events, pointEvent).score).toEqual({ homePoints: 1, awayPoints: 0 })
  })

  it('with includeRallyStart, also the rally_start that opened that rally (like Undo)', () => {
    const plan = planPointRemoval(events, pointEvent, { includeRallyStart: true })
    expect(plan.deleteEventIds.sort((a, b) => a - b)).toEqual([20, 195, 201, 202])
  })

  it('finds the newest point of the set when no point is given', () => {
    expect(planPointRemoval(events, null, { setIndex: 5 }).deleteEventIds).toContain(20)
    expect(planPointRemoval(events, null, { setIndex: 3 })).toBeNull()
    expect(planPointRemoval(events, { id: 99, type: 'timeout', seq: 21, setIndex: 5 })).toBeNull()
  })
})
